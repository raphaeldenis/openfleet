#!/usr/bin/env node
import { closeSync, openSync, readSync } from 'node:fs';
import { homedir } from 'node:os';

const CPU_BY_TARGET = { 'aarch64-apple-darwin': 'arm64', 'x86_64-apple-darwin': 'x86_64' };
const CPU_BY_HEADER = { 0x0100000c: 'arm64', 0x01000007: 'x86_64' };
const HEADER_BYTES = 32;
const MACH_O_64_MAGIC = 0xfeedfacf;
const EXECUTABLE_TYPE = 2;

function readExecutableCpu(binaryPath) {
  const header = Buffer.alloc(HEADER_BYTES);
  const descriptor = openSync(binaryPath, 'r');
  try {
    const bytesRead = readSync(descriptor, header, 0, HEADER_BYTES, 0);
    const isCompleteHeader = bytesRead === HEADER_BYTES;
    if (!isCompleteHeader) return 'a truncated Mach-O header';
    const isThinMachO = header.readUInt32LE(0) === MACH_O_64_MAGIC;
    if (!isThinMachO) return 'not a thin 64-bit Mach-O';
    const isExecutable = header.readUInt32LE(12) === EXECUTABLE_TYPE;
    if (!isExecutable) return 'not a Mach-O executable';
    return CPU_BY_HEADER[header.readUInt32LE(4)] ?? 'an unknown CPU';
  } finally {
    closeSync(descriptor);
  }
}

function main() {
  const [target, ...binaryPaths] = process.argv.slice(2);
  const expectedCpu = Object.hasOwn(CPU_BY_TARGET, target) ? CPU_BY_TARGET[target] : undefined;
  if (expectedCpu === undefined || binaryPaths.length === 0) {
    throw new Error('usage: verify-architecture.mjs <aarch64-apple-darwin|x86_64-apple-darwin> <binary> [<binary> ...]');
  }
  for (const binaryPath of binaryPaths) {
    const actualCpu = readExecutableCpu(binaryPath);
    if (actualCpu !== expectedCpu) throw new Error(`${binaryPath} is ${actualCpu}, expected ${expectedCpu} for ${target}`);
    console.log(`architecture: ${binaryPath} matches ${target}`);
  }
}

try {
  main();
} catch (error) {
  const home = homedir();
  const message = String(error.message).split('\n')[0];
  const hasMeaningfulHome = home !== '' && home !== '/';
  console.error(`verify-architecture: ${hasMeaningfulHome ? message.replaceAll(home, '~') : message}`);
  process.exitCode = 1;
}
