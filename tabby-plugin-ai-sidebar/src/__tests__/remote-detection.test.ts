import { describe, it, expect } from 'vitest'
import {
    detectRemoteFromCommand,
    parseRemoteTarget,
    remoteFromProfile,
} from '../tab-monitor'

describe('detectRemoteFromCommand', () => {
    it('detects interactive remote-entry commands', () => {
        expect(detectRemoteFromCommand('ssh ubuntu@gpu-01')).toBe('ssh')
        expect(detectRemoteFromCommand('/usr/bin/ssh -p 2222 host')).toBe('ssh')
        expect(detectRemoteFromCommand('mosh user@host')).toBe('mosh')
        expect(detectRemoteFromCommand('mosh-client 1.2.3.4 60001')).toBe('mosh')
        expect(detectRemoteFromCommand('docker exec -it web bash')).toBe('docker')
        expect(detectRemoteFromCommand('docker run -it ubuntu')).toBe('docker')
        expect(detectRemoteFromCommand('podman exec -it c1 sh')).toBe('podman')
        expect(detectRemoteFromCommand('kubectl exec -it pod-x -- sh')).toBe('kubectl')
        expect(detectRemoteFromCommand('oc exec -it pod-x -- sh')).toBe('kubectl')
        expect(detectRemoteFromCommand('tsh ssh node')).toBe('tsh')
    })

    it('does NOT match shells, ssh sibling tools, or bare/help invocations', () => {
        expect(detectRemoteFromCommand('-zsh')).toBeNull()
        expect(detectRemoteFromCommand('/bin/bash')).toBeNull()
        expect(detectRemoteFromCommand('ssh-agent -s')).toBeNull()
        expect(detectRemoteFromCommand('ssh-keygen -t ed25519')).toBeNull()
        expect(detectRemoteFromCommand('ssh')).toBeNull() // no argument
        expect(detectRemoteFromCommand('docker ps')).toBeNull() // not exec/run/attach
        expect(detectRemoteFromCommand('kubectl get pods')).toBeNull()
    })
})

describe('parseRemoteTarget', () => {
    it('extracts the ssh destination past option flags', () => {
        expect(parseRemoteTarget('ssh', 'ssh ubuntu@gpu-01')).toBe('ubuntu@gpu-01')
        expect(parseRemoteTarget('ssh', 'ssh -p 2222 -i ~/.ssh/id host')).toBe('host')
        expect(parseRemoteTarget('ssh', 'ssh host -- uptime')).toBe('host')
        expect(parseRemoteTarget('ssh', '/usr/bin/ssh -o StrictHostKeyChecking=no me@1.2.3.4')).toBe('me@1.2.3.4')
    })

    it('extracts docker/kubectl targets and stops before `--`', () => {
        expect(parseRemoteTarget('docker', 'docker exec -it web bash')).toBe('web')
        expect(parseRemoteTarget('docker', 'docker run -e FOO=bar -it ubuntu:22.04')).toBe('ubuntu:22.04')
        // an unrecognised value-flag (-v) leaks its /path as the next token; the
        // absolute-path skip avoids mislabeling the chip with the mount value.
        expect(parseRemoteTarget('docker', 'docker run -v /a:/b ubuntu')).toBe('ubuntu')
        expect(parseRemoteTarget('kubectl', 'kubectl exec -n prod pod-x -- sh')).toBe('pod-x')
        expect(parseRemoteTarget('kubectl', 'kubectl exec pod-y -it -- bash')).toBe('pod-y')
    })

    it('returns null when no destination can be parsed (chip degrades to kind-only)', () => {
        expect(parseRemoteTarget('ssh', 'ssh')).toBeNull()
    })
})

describe('remoteFromProfile', () => {
    const fake = (profile: any) => remoteFromProfile({ profile } as any)

    it('reads host/user from a connectable SSH/Telnet profile', () => {
        expect(fake({ type: 'ssh', options: { host: 'gpu-01', user: 'ubuntu' } }))
            .toEqual({ kind: 'ssh', target: 'ubuntu@gpu-01' })
        expect(fake({ type: 'ssh', options: { host: 'gpu-01' } }))
            .toEqual({ kind: 'ssh', target: 'gpu-01' })
        expect(fake({ type: 'telnet', options: { host: 'switch-1' } }))
            .toEqual({ kind: 'telnet', target: 'switch-1' })
    })

    it('uses the serial port / profile name as the target', () => {
        expect(fake({ type: 'serial', name: 'Arduino', options: { port: '/dev/ttyUSB0' } }))
            .toEqual({ kind: 'serial', target: '/dev/ttyUSB0' })
    })

    it('returns null for a plain local tab', () => {
        expect(fake({ type: 'local', options: {} })).toBeNull()
        expect(remoteFromProfile({} as any)).toBeNull()
    })
})
