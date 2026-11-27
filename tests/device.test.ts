import { describe, expect, it } from 'vitest';
import { describeDevice, describePlace } from '../src/admin/device';

describe('admin device names', () => {
  it('names browsers and systems', () => {
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36')).toBe('Chrome · Windows');
    expect(describeDevice('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0')).toBe('Edge · Windows');
    expect(describeDevice('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15')).toBe('Safari · macOS');
    expect(describeDevice('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1')).toBe('Safari · iOS (phone)');
    expect(describeDevice('Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36')).toBe('Chrome · Android (phone)');
    expect(describeDevice('Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0')).toBe('Firefox · Linux');
  });

  it('names the desktop app and scripts', () => {
    expect(describeDevice('Cherrion-Desktop/1.3.0 (Windows 10)')).toBe('Cherrion desktop 1.3.0 · Windows 10');
    expect(describeDevice('Cherrion-Desktop')).toBe('Cherrion desktop');
    expect(describeDevice('curl/8.5.0')).toBe('Script (curl)');
    expect(describeDevice('')).toBe('Unknown device');
  });

  it('describes places', () => {
    expect(describePlace({ city: 'Lisbon', region: '11', country: 'PT' })).toBe('Lisbon, 11, Portugal');
    expect(describePlace({ city: 'New York', region: 'NY', country: 'US' })).toBe('New York, NY, United States');
    expect(describePlace({ country: '' })).toBe('Unknown place');
  });
});
