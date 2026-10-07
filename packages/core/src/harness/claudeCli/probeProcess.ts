export function probeProcess(pid: number): 'alive' | 'exited' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    const isMissingProcess = (error as NodeJS.ErrnoException).code === 'ESRCH';
    return isMissingProcess ? 'exited' : 'unknown';
  }
}
