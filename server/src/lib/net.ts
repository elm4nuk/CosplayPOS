import os from 'node:os';

/** Alamat IPv4 LAN laptop server, adapter Wi-Fi/Ethernet diurutkan paling depan. */
export function lanAddresses(): string[] {
  const found: { name: string; address: string }[] = [];
  for (const [name, infos] of Object.entries(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue; // link-local: tidak terhubung router
      found.push({ name, address: info.address });
    }
  }
  const score = (n: string) => {
    const s = n.toLowerCase();
    if (/(vethernet|virtual|vmware|vbox|wsl|hyper-v|docker|tailscale|zerotier|loopback)/.test(s)) return 2;
    if (/(wi-?fi|wlan|wireless|ethernet|eth|en\d)/.test(s)) return 0;
    return 1;
  };
  return found.sort((a, b) => score(a.name) - score(b.name)).map((f) => f.address);
}
