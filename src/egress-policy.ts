import { BlockList, isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

const denied = new BlockList();
for (const [ip, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) denied.addSubnet(ip, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [ip, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]] as const) denied.addSubnet(ip, prefix, 'ipv6');

export function isPublicAddress(address: string) {
  const version = isIP(address);
  if (version === 4) return !denied.check(address, 'ipv4');
  if (version === 6) return globalV6.check(address, 'ipv6') && !denied.check(address, 'ipv6');
  return false;
}

const normalizeHost = (host: string) => host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();

export async function resolvePublicTarget(url: URL, resolve = (host: string) => lookup(host, { all: true, verbatim: true }), denyHosts: string[] = []) {
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Target denied');
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80));
  if (![80, 443].includes(port)) throw new Error('Port denied');
  const hostname = normalizeHost(url.hostname);
  const managementHosts = denyHosts.map(normalizeHost);
  if (managementHosts.includes(hostname)) throw new Error('Management target denied');
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolve(hostname);
  if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) throw new Error('Address denied');
  // Different hostnames can share a CDN address. Do not turn a denied hostname
  // into an IP ban for other named websites. Explicitly denied IPs still apply
  // to every DNS answer, and direct-IP requests still check management DNS.
  // Hostname filtering is defense in depth, not management authentication.
  for (const host of managementHosts) {
    if (!isIP(host) && !family) continue;
    const ips = isIP(host) ? [{ address: host }] : await resolve(host);
    if (!ips.length) throw new Error('Management address unavailable');
    const management = new BlockList();
    for (const ip of ips) management.addAddress(ip.address, isIP(ip.address) === 6 ? 'ipv6' : 'ipv4');
    if (addresses.some(address => management.check(address.address, address.family === 6 ? 'ipv6' : 'ipv4'))) throw new Error('Management address denied');
  }
  // The dial uses this exact resolved address, never a second DNS lookup.
  const chosen = addresses.find(address => address.family === 4) ?? addresses[0];
  return { address: chosen.address, family: chosen.family, port, hostname };
}
