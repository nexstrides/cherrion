// Settings → Owner recovery: the opt-in that lets this server's owner make a new recovery key for
// someone who lost both their password and recovery key (see src/escrow.ts).
import { hasSession } from '../api';
import * as session from '../desktop/session';
import { disableEscrow, enableEscrow, escrowStatus, ownerKeyCode, type EscrowStatus } from '../escrow';
import { DESKTOP } from '../platform';
import { onSettingsOpen } from './app';
import { confirmDialog } from './dialog';
import { $, $input, toast } from './dom';

let status: EscrowStatus | null = null;

function paint(): void {
  const section = $('escrow-section');
  const box = $input('input-escrow');
  if (!status?.available || !status.adminKey) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');
  box.checked = status.enabled;
  $('escrow-owner').textContent = `Owner key: ${ownerKeyCode(status.adminKey)}. The owner sees the same code in their dashboard; compare them if you want to be sure.`;
}

async function refresh(): Promise<void> {
  $('escrow-section').classList.add('hidden');
  status = null;
  // An unlinked desktop file has no server (and no owner).
  if (!hasSession() || (DESKTOP && !session.linkedAccount())) return;
  try { status = await escrowStatus(); } catch { status = null; }
  paint();
}

export function wireEscrowSettings(): void {
  onSettingsOpen(() => void refresh());
  const box = $input('input-escrow');
  box.onchange = async () => {
    const turnOn = box.checked;
    box.checked = !turnOn; // stays as it was until the server confirms
    if (!status?.adminKey) return;
    if (turnOn) {
      const ok = await confirmDialog({
        title: 'Turn on owner recovery?',
        message: 'Your vault key will also be encrypted for the owner of this Cherrion server. If you lose both your password and your recovery key, they can then give you a new recovery key. It also means the owner could read your notes.',
        confirmLabel: 'Turn on',
        danger: false,
      });
      if (!ok) return;
    }
    box.disabled = true;
    try {
      status = turnOn ? await enableEscrow(status.adminKey) : await disableEscrow();
      toast(turnOn ? 'Owner recovery is on.' : 'Owner recovery is off. The owner can no longer restore your notes.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 7000);
    } finally {
      box.disabled = false;
      paint();
    }
  };
}
