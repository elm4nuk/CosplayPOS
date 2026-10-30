export const nowIso = (): string => new Date().toISOString();

export interface LocalParts {
  date: string; // YYYY-MM-DD
  hour: number; // 0-23
  display: string; // DD/MM/YYYY HH.mm
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function localParts(iso: string, timeZone: string): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(iso))) parts[p.type] = p.value;
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  return {
    date,
    hour: Number(parts.hour),
    display: `${parts.day}/${parts.month}/${parts.year} ${parts.hour}.${parts.minute}`,
  };
}

/** "17/10/2026 10.15.30" — untuk CSV. */
export function localDateTime(iso: string, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(iso))) parts[p.type] = p.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

/** Nama file aman untuk Windows: 2026-10-17T10-30-00-123Z */
export const fileStamp = (d = new Date()): string => d.toISOString().replace(/[:.]/g, '-');
