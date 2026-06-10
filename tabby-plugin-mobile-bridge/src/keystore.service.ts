import { Injectable } from '@angular/core'
import * as crypto from 'crypto'
import * as fs from 'fs/promises'
import * as os from 'os'
import * as path from 'path'

/**
 * Local AES-256-GCM-encrypted secret store. Used by BindingStoreService
 * to move bot tokens / app secrets out of the plain-text bindings JSON
 * and into `~/.glanceterm/mobile-bridge-secrets.enc`, with only a
 * {@link SecretRef} pointer left in the binding record.
 *
 * Key derivation: PBKDF2-SHA256 (100k iters) from `hostname|user` mixed
 * with a 32-byte salt persisted at `~/.glanceterm/mobile-bridge-keystore.salt`.
 * The salt is fine to leave readable — its purpose is rainbow-table
 * defence, not secrecy. The key never touches disk.
 *
 * Threat model addressed: casual file-snooping (someone reads
 * `~/.glanceterm/` over an SSH session, syncs the dir to iCloud Drive,
 * etc.). NOT addressed: a process running as the same user can re-derive
 * the same key trivially — that's an OS-level boundary we can't cross
 * from userspace. If the salt file is lost or the host moves, the
 * existing entries become unreadable and the user has to re-pair; that's
 * a feature (defends against backup-leak) and surfaced as a "decrypt
 * failed, re-pair" error from {@link read}.
 *
 * Pattern lifted from zarazhangrui/lark-coding-agent-bridge's
 * `src/config/keystore.ts`. Same cipher, same KDF parameters,
 * different file path.
 */
@Injectable()
export class KeystoreService {
    private static readonly FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge-secrets.enc')
    private static readonly SALT_FILE = path.join(os.homedir(), '.glanceterm', 'mobile-bridge-keystore.salt')
    private static readonly KDF_ITERS = 100_000
    private static readonly KEY_LEN = 32          // AES-256
    private static readonly IV_LEN = 12           // GCM standard
    private static readonly SALT_LEN = 32

    private cached: KeystoreFile | null = null
    private key: Buffer | null = null
    private loadPromise: Promise<void> | null = null
    /** Non-null iff the secrets file existed but failed to load (corrupt
     *  JSON, EACCES, truncated sync). In that state reads answer "no
     *  entry" but writes are refused — a save would replace the original
     *  file with our empty in-memory copy and destroy every secret it
     *  still holds. Cleared only by a process restart after the user
     *  repairs or deletes the file. */
    private degradedReason: string | null = null
    /** Serialises writes so a settings-UI flurry (add binding immediately
     *  followed by toggle enabled, etc.) doesn't race on the JSON file
     *  and silently drop the earlier write. */
    private writeQueue: Promise<void> = Promise.resolve()

    /** Read the plaintext for `id`. Throws if the id is unknown or the
     *  ciphertext fails GCM auth (most often: salt rotated, key changed).
     *  Callers should surface the error as "re-pair to recover" rather
     *  than silently treating it as "no token." */
    async read (id: string): Promise<string> {
        await this.load()
        const entry = this.cached!.entries[id]
        if (!entry) throw new Error(`KeystoreService: no entry for id=${id}`)
        try {
            return this.decrypt(entry)
        } catch (err) {
            throw new Error(
                `KeystoreService: decrypt failed for id=${id} (key derivation likely changed; re-pair the binding to recover). `
                + `Underlying: ${err instanceof Error ? err.message : String(err)}`,
            )
        }
    }

    /** Persist `plaintext` under `id`. Overwrites if `id` already exists.
     *  Throws without touching disk if the store is degraded (existing
     *  file failed to load) — see {@link assertWritable}. */
    async write (id: string, plaintext: string): Promise<void> {
        await this.load()
        this.assertWritable()
        this.cached!.entries[id] = this.encrypt(plaintext)
        await this.enqueueSave()
    }

    /** Remove the entry for `id`. No-op if it doesn't exist. */
    async delete (id: string): Promise<void> {
        await this.load()
        if (this.cached!.entries[id]) {
            delete this.cached!.entries[id]
            await this.enqueueSave()
        }
    }

    /** True iff an entry for `id` exists. */
    async has (id: string): Promise<boolean> {
        await this.load()
        return id in this.cached!.entries
    }

    private async load (): Promise<void> {
        if (this.cached !== null) return
        if (this.loadPromise) return this.loadPromise
        // Outer try captures deriveKey rejections (pbkdf2 callback error,
        // salt-file mkdir EACCES, os.userInfo throw); inner try handles
        // the missing-file / parse-error path. On any failure the
        // loadPromise is cleared so a subsequent call retries from scratch
        // — without this a transient deriveKey error would pin every
        // future read/write/delete to the same rejected promise for the
        // process lifetime.
        this.loadPromise = (async () => {
            try {
                this.key = await this.deriveKey()
                try {
                    const raw = await fs.readFile(KeystoreService.FILE, 'utf8')
                    const parsed = JSON.parse(raw) as unknown
                    // A JSON primitive (42, "x", true) would survive the
                    // property reads below via the ?? fallbacks and leave
                    // the store writable — same overwrite risk as corrupt
                    // JSON, so route it into the degraded path.
                    if (typeof parsed !== 'object' || parsed === null) {
                        throw new Error('secrets file is valid JSON but not an object')
                    }
                    this.cached = {
                        version: (parsed as Partial<KeystoreFile>).version ?? 1,
                        entries: (parsed as Partial<KeystoreFile>).entries ?? {},
                    }
                } catch (err: unknown) {
                    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                        this.degradedReason = err instanceof Error ? err.message : String(err)
                        // eslint-disable-next-line no-console
                        console.warn('[mobile-bridge:keystore] load failed — entering degraded (write-refuse) mode:', err)
                    }
                    this.cached = { version: 1, entries: {} }
                }
            } catch (err) {
                this.loadPromise = null
                throw err
            }
        })()
        return this.loadPromise
    }

    private enqueueSave (): Promise<void> {
        const next = this.writeQueue.then(() => this.save())
        // Don't poison the chain on a single failure — subsequent writes
        // still need to attempt fsync (the user might fix a permission
        // issue between writes). Re-thrown errors propagate to the caller
        // that scheduled THIS write so they can react / log.
        this.writeQueue = next.then(() => undefined, () => undefined)
        return next
    }

    private assertWritable (): void {
        if (this.degradedReason) {
            throw new Error(
                `KeystoreService: refusing to write — the existing secrets file failed to load (${this.degradedReason}). `
                + 'Saving now would overwrite it with an empty store and destroy the secrets it still holds. '
                + `To recover: restore ${KeystoreService.FILE} from backup, or delete it `
                + '(and re-pair every binding) to start fresh, then restart GlanceTerm.',
            )
        }
    }

    private async save (): Promise<void> {
        if (!this.cached) throw new Error('KeystoreService: save before load')
        this.assertWritable()
        const dir = path.dirname(KeystoreService.FILE)
        await fs.mkdir(dir, { recursive: true })
        const tmp = `${KeystoreService.FILE}.${process.pid}.tmp`
        const body = JSON.stringify(this.cached, null, 2)
        await fs.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 })
        await fs.rename(tmp, KeystoreService.FILE)
    }

    private async deriveKey (): Promise<Buffer> {
        const salt = await this.loadOrCreateSalt()
        const pwd = Buffer.from(`${os.hostname()}|${os.userInfo().username}`)
        return new Promise<Buffer>((resolve, reject) => {
            crypto.pbkdf2(
                pwd,
                salt,
                KeystoreService.KDF_ITERS,
                KeystoreService.KEY_LEN,
                'sha256',
                (err, derived) => err ? reject(err) : resolve(derived),
            )
        })
    }

    private async loadOrCreateSalt (): Promise<Buffer> {
        let exists = true
        let salt: Buffer | undefined
        try {
            salt = await fs.readFile(KeystoreService.SALT_FILE)
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
            exists = false
        }
        if (exists) {
            // A wrong-length salt means corruption (truncated sync,
            // hand-edit, filesystem bug). Silently overwriting would
            // destroy access to every entry already encrypted under the
            // original salt — worse than the corruption itself. Throw
            // and let the user decide: restore the salt from backup, or
            // delete BOTH the salt and secrets files to re-pair from
            // scratch.
            if (salt!.length !== KeystoreService.SALT_LEN) {
                throw new Error(
                    `KeystoreService: salt file ${KeystoreService.SALT_FILE} has wrong length `
                    + `(${salt!.length}, expected ${KeystoreService.SALT_LEN}). `
                    + 'Refusing to regenerate — that would silently destroy access to existing '
                    + 'encrypted entries. To recover: restore the salt file from backup, or '
                    + `delete BOTH ${KeystoreService.SALT_FILE} AND ${KeystoreService.FILE} `
                    + 'to start fresh (you will need to re-pair every binding).',
                )
            }
            return salt!
        }
        // Fresh install path (ENOENT) — write a new salt.
        const fresh = crypto.randomBytes(KeystoreService.SALT_LEN)
        const dir = path.dirname(KeystoreService.SALT_FILE)
        await fs.mkdir(dir, { recursive: true })
        await fs.writeFile(KeystoreService.SALT_FILE, fresh, { mode: 0o600 })
        return fresh
    }

    private encrypt (plaintext: string): EncryptedEntry {
        const iv = crypto.randomBytes(KeystoreService.IV_LEN)
        const cipher = crypto.createCipheriv('aes-256-gcm', this.key!, iv)
        const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
        const tag = cipher.getAuthTag()
        return {
            iv: iv.toString('base64'),
            data: ciphertext.toString('base64'),
            tag: tag.toString('base64'),
        }
    }

    private decrypt (entry: EncryptedEntry): string {
        const iv = Buffer.from(entry.iv, 'base64')
        const tag = Buffer.from(entry.tag, 'base64')
        const data = Buffer.from(entry.data, 'base64')
        const decipher = crypto.createDecipheriv('aes-256-gcm', this.key!, iv)
        decipher.setAuthTag(tag)
        return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8')
    }
}

interface KeystoreFile {
    version: 1
    entries: Record<string, EncryptedEntry>
}

interface EncryptedEntry {
    /** Base64 12-byte GCM IV. */
    iv: string
    /** Base64 ciphertext. */
    data: string
    /** Base64 16-byte GCM auth tag. */
    tag: string
}
