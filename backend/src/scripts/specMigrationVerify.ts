import { main } from '@/scripts/specOperations'

void main(['migration-verify', ...process.argv.slice(2)]).then((code) => { process.exitCode = code })
