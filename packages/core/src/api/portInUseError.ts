export class PortInUseError extends Error {
  constructor(port: number) {
    super(`port ${port} is already in use`);
  }
}
