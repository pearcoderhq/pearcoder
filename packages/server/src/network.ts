import { networkInterfaces } from 'node:os';

/** Non-internal IPv4 addresses of this machine, for LAN invitations and the Host allowlist. */
export function lanAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses;
}
