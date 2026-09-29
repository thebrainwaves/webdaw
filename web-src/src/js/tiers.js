import './storage-migrate.js';
// Feature tiers — PLACEHOLDER ONLY. There are no payments, accounts or licence checks: the tier is
// a local preference (Preferences → Tier) and every tier can be switched to freely for testing.
// Edit this one file to change which feature belongs to which tier.
export const TIERS = ['basic', 'mid', 'large'];
export const TIER_LABELS = { basic: 'Basic (free)', mid: 'Mid', large: 'Large' };
// Default tier for new installs. 'large' keeps everything visible while the tiers are placeholders;
// set to 'basic' to preview the free experience.
export const DEFAULT_TIER = 'large';

// feature key -> minimum tier
export const FEATURES = {
  // core (Basic)
  'core.recording': 'basic', 'core.mixer': 'basic', 'core.midi': 'basic', 'inst.drums': 'basic', 'inst.synth': 'basic',
  'fx.eq': 'basic', 'fx.compressor': 'basic', 'fx.limiter': 'basic', 'fx.delay': 'basic', 'fx.reverb': 'basic', 'fx.distortion': 'basic',
  'automix.basic': 'basic', 'tempo.tap': 'basic',
  // Mid
  'fx.chorus': 'mid', 'fx.autopan': 'mid', 'fx.tremolo': 'mid', 'fx.amp': 'mid', 'fx.maximizer': 'mid', 'fx.pitch': 'mid',
  'fx.rack': 'mid', 'grouping': 'mid', 'inst.wavetable': 'mid', 'automix.full': 'mid', 'adaptive': 'mid',
  'tempo.detect': 'mid', // auto-timing: live tempo detection, "Detect tempo", Follow mode, clip BPM detection
  // Large (everything, incl. future pro features)
  'keyfollow': 'large',
};
// Auto-Mix roles available with 'automix.basic' only (full adds drum pieces, amp/acoustic variants, backing vox, "from bar")
export const BASIC_ROLES = ['auto', 'drum_kit', 'bass_di', 'gtr_clean', 'gtr_crunch', 'gtr_highgain', 'vox_lead', 'keys', 'other'];

const KEY = 'auduio.tier';
let current = (() => { try { const v = localStorage.getItem(KEY); return TIERS.includes(v) ? v : DEFAULT_TIER; } catch (e) { return DEFAULT_TIER; } })();
const listeners = [];
export const getTier = () => current;
export function setTier(t) { if (!TIERS.includes(t)) return; current = t; try { localStorage.setItem(KEY, t); } catch (e) {} listeners.forEach((f) => f(t)); }
export const onTierChange = (f) => listeners.push(f);
export const requiredTier = (feature) => FEATURES[feature] || 'large'; // unknown/future features -> Large
export const allowed = (feature) => TIERS.indexOf(current) >= TIERS.indexOf(requiredTier(feature));
