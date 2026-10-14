import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const whisper = join(root, 'vendor', 'whisper.cpp', 'build', 'bin', 'whisper-server');
const python = join(root, '.venv', 'bin', 'python');
const services = [
  ['Whisper', whisper, ['-m', 'models/ggml-small.bin', '--host', '127.0.0.1', '--port', '8081', '-l', 'en', '-t', '4', '-ng']],
  ['English voice', python, ['-m', 'piper.http_server', '-m', 'en_US-lessac-medium', '--data-dir', 'models/piper', '--host', '127.0.0.1', '--port', '5001']],
  ['Hindi voice', python, ['-m', 'piper.http_server', '-m', 'hi_IN-priyamvada-medium', '--data-dir', 'models/piper', '--host', '127.0.0.1', '--port', '5002']]
];
const children = [];
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const [name, command, args] of services) {
  const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
  children.push(child);
  child.on('error', error => { console.error(`${name}: ${error.message}`); stop(1); });
  child.on('exit', code => { if (!stopping) { console.error(`${name} stopped (${code}).`); stop(code || 1); } });
}
process.on('SIGINT', () => stop());
process.on('SIGTERM', () => stop());
