// Readable names for the admin dashboard's connection history: "Chrome · Windows", "Cherrion desktop
// 1.3.0 · Windows 10", and a place from Vercel's approximate location headers.

const OS: [RegExp, string][] = [
  [/Windows NT 10\.0/, 'Windows'],
  [/Windows NT 6\.3/, 'Windows 8.1'],
  [/Windows NT 6\.1/, 'Windows 7'],
  [/Windows/, 'Windows'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux/, 'Linux'],
];

const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\/(\d+)/, 'Edge'],
  [/OPR\/(\d+)/, 'Opera'],
  [/SamsungBrowser\/(\d+)/, 'Samsung Internet'],
  [/Firefox\/(\d+)|FxiOS\/(\d+)/, 'Firefox'],
  [/CriOS\/(\d+)/, 'Chrome'],
  [/Chrome\/(\d+)/, 'Chrome'],
  [/Version\/(\d+)[\d.]* .*Safari\//, 'Safari'],
];

export function describeDevice(userAgent: string | null | undefined): string {
  const ua = userAgent ?? '';
  if (!ua) return 'Unknown device';
  const desktop = /^Cherrion-Desktop(?:\/([\w.-]+))?(?: \(([^)]*)\))?/.exec(ua);
  if (desktop) return `Cherrion desktop${desktop[1] && desktop[1] !== 'dev' ? ` ${desktop[1]}` : ''}${desktop[2] ? ` · ${desktop[2]}` : ''}`;
  const os = OS.find(([re]) => re.test(ua))?.[1];
  const browser = BROWSERS.find(([re]) => re.test(ua));
  const name = browser ? browser[1] : /node|undici|curl|python|go-http|java/i.test(ua) ? `Script (${ua.split(/[\s/]/)[0]})` : 'Browser';
  const mobile = /Mobile|iPhone|Android.*Mobile/.test(ua) ? ' (phone)' : /iPad|Tablet/.test(ua) ? ' (tablet)' : '';
  return `${name}${os ? ` · ${os}` : ''}${mobile}`;
}

let regionNames: Intl.DisplayNames | null = null;
function countryName(code: string): string {
  try {
    regionNames ??= new Intl.DisplayNames(['en'], { type: 'region' });
    return regionNames.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function describePlace(p: { city?: string | null; region?: string | null; country?: string | null }): string {
  const country = p.country ? countryName(p.country) : '';
  const parts = [p.city, p.region && p.region !== p.city ? p.region : '', country].filter((x): x is string => !!x);
  return parts.join(', ') || 'Unknown place';
}
