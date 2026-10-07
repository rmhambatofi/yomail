import { isIP } from 'node:net';

/**
 * SSRF guard for the replay feature: decides whether an IP address is a public
 * Internet address. Everything loopback, link-local, private (RFC 1918 / 4193),
 * carrier-grade NAT, documentation, multicast, reserved or unspecified is refused,
 * including IPv4 addresses embedded in IPv6 (mapped, NAT64, compat).
 */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return isPublicV4(address);
  if (family === 6) return isPublicV6(address);
  return false;
}

/** Hostnames that never need DNS to be refused. */
export function isLocalHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa') ||
    host === 'ip6-localhost' ||
    host === 'ip6-loopback'
  );
}

function isPublicV4(address: string): boolean {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return false;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false; // this network, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 169 && b === 254) return false; // link-local
  if (a === 172 && b >= 16 && b <= 31) return false; // private 172.16/12
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF, TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function isPublicV6(address: string): boolean {
  const groups = expandV6(address);
  if (!groups) return false;
  const [g0, g1, g2, g3, g4, g5] = groups;
  const allZero = groups.every((g) => g === 0);
  if (allZero) return false; // ::
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return false; // ::1
  // IPv4-mapped (::ffff:a.b.c.d), NAT64 (64:ff9b::/96) and deprecated compat (::a.b.c.d): judge the IPv4.
  if (groups.slice(0, 5).every((g) => g === 0) && g5 === 0xffff) return isPublicV4(v4Tail(groups));
  if (g0 === 0x64 && g1 === 0xff9b && [g2, g3, g4, g5].every((g) => g === 0)) {
    return isPublicV4(v4Tail(groups));
  }
  if (groups.slice(0, 6).every((g) => g === 0)) return isPublicV4(v4Tail(groups));
  if ((g0 & 0xfe00) === 0xfc00) return false; // unique local fc00::/7
  if ((g0 & 0xffc0) === 0xfe80) return false; // link-local fe80::/10
  if ((g0 & 0xff00) === 0xff00) return false; // multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2001 && g1 === 0) return false; // Teredo: tunnels, embeds an IPv4
  if (g0 === 0x2002) return isPublicV4(`${g1 >> 8}.${g1 & 0xff}.${g2 >> 8}.${g2 & 0xff}`); // 6to4
  return true;
}

function v4Tail(groups: number[]): string {
  const hi = groups[6]!;
  const lo = groups[7]!;
  return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/** Eight 16-bit groups of an IPv6 address (handles `::` and a dotted IPv4 tail), or null. */
function expandV6(address: string): number[] | null {
  let text = address;
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);
  // Dotted IPv4 tail -> two hex groups.
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = tail.split('.').map(Number);
    if (parts.length !== 4) return null;
    const [a, b, c, d] = parts as [number, number, number, number];
    text = `${text.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...rest].map((g) =>
    Number.parseInt(g, 16),
  );
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null;
}
