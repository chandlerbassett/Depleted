// Application-wide constants. No magic numbers in the codebase — define them here.
// Zone IDs and spell IDs must be verified against the current Midnight patch notes.

// ---------------------------------------------------------------------------
// Arena zone IDs — instance map IDs as reported by ZONE_CHANGE in the combat log.
// Source: https://warcraft.wiki.gg/wiki/InstanceID (Arenas section)
// Verified from real log: Tiger's Peak = 1134 (WoWCombatLog-041526_131655).
// ---------------------------------------------------------------------------

export const ARENA_ZONE_IDS: ReadonlySet<number> = new Set([
  572, // Ruins of Lordaeron
  617, // Dalaran Sewers
  618, // Ring of Valor
  980, // Tol'Viron Arena
  1134, // Tiger's Peak — verified from real log
  1504, // Black Rook Hold Arena
  1505, // Nagrand Arena
  1552, // Ashamane's Fall
  1672, // Blade's Edge Arena
  1825, // Hook Point
  2373, // Empyrean Domain
  2509, // Maldraxxus Coliseum
  2547, // Enigma Crucible
  2563, // Nokhudon Proving Grounds
  1911, // Mugambala — verified from real log (ZONE_CHANGE,1911,"Mugambala",0)
  2759, // Cage of Carnage (TWW patch 11.1.0)
  2167  // The Robodrome — verified from real log (ZONE_CHANGE,2167,"The Robodrome",0)
])

// Human-readable zone names keyed by zone ID.
export const ARENA_ZONE_NAMES: Readonly<Record<number, string>> = {
  572: 'Ruins of Lordaeron',
  617: 'Dalaran Sewers',
  618: 'Ring of Valor',
  980: "Tol'Viron Arena",
  1134: "Tiger's Peak",
  1504: 'Black Rook Hold Arena',
  1505: 'Nagrand Arena',
  1552: "Ashamane's Fall",
  1672: "Blade's Edge Arena",
  1825: 'Hook Point',
  2373: 'Empyrean Domain',
  2509: 'Maldraxxus Coliseum',
  2547: 'Enigma Crucible',
  2563: 'Nokhudon Proving Grounds',
  1911: 'Mugambala',
  2759: 'Cage of Carnage',
  2167: 'The Robodrome'
}

// ---------------------------------------------------------------------------
// Bracket identifiers as they appear in ARENA_MATCH_START combat log events
// ---------------------------------------------------------------------------

export const BRACKET_FIELD_MAP: Readonly<Record<string, import('./ipc.types').ArenaBracket>> = {
  '2v2': '2v2',
  '3v3': '3v3',
  'solo shuffle': 'solo-shuffle',         // pre-Midnight bracket name
  'rated solo shuffle': 'solo-shuffle',   // Midnight (12.x) bracket name
  'skirmish': 'skirmish'
}

// ---------------------------------------------------------------------------
// Solo Shuffle
// ---------------------------------------------------------------------------

export const SOLO_SHUFFLE_ROUNDS_PER_SESSION = 6

// Rounds 1-5 stop the recorder immediately on the round-ending death so the next
// round's recorder.start() isn't delayed (Solo Shuffle re-queues the next round within
// seconds). The final round has no next round to rush for, so its recorder.stop() is
// delayed by this many seconds first — otherwise the raw capture (and therefore the
// trimmed output) ends at the exact death frame, cutting off the death animation/results
// screen the user actually watched play out live.
export const SOLO_SHUFFLE_FINAL_ROUND_POST_ROLL_SECS = 3

// Mythic+: keep recording this long after CHALLENGE_MODE_END so the completion banner
// and loot chest make it into the video.
export const MYTHIC_PLUS_POST_ROLL_SECS = 18
// Mythic+: if the player leaves the dungeon mid-key and hasn't come back (or the key
// hasn't ended) after this long, treat the key as abandoned and save what we have.
export const MYTHIC_PLUS_ABANDON_TIMEOUT_SECS = 180
// Mythic+: if the combat log goes quiet for this long mid-key (game closed, logging
// turned off, group disbanded without a zone change), close the key as abandoned.
export const MYTHIC_PLUS_IDLE_TIMEOUT_SECS = 300

// ---------------------------------------------------------------------------
// Death recap
// ---------------------------------------------------------------------------

// How far back from a death to collect damage/healing/CC/defensive-usage context.
export const DEATH_RECAP_WINDOW_SECS = 10

// ---------------------------------------------------------------------------
// Timeline event colours for canvas rendering
// ---------------------------------------------------------------------------

export const TIMELINE_COLORS: Readonly<Record<import('./ipc.types').TimelineEventType, string>> = {
  'arena-start': '#ffffff',
  'arena-end': '#ffffff',
  'death-player': '#ef4444', // red-500
  'death-enemy': '#f97316', // orange-500
  cc: '#eab308',            // yellow-500
  defensive: '#3b82f6',     // blue-500
  offensive: '#f97316',     // orange-500
  interrupt: '#22c55e',     // green-500
  'cc-break': '#a855f7',    // purple-500
  trinket: '#e879f9',       // fuchsia-400
  'key-start': '#ffffff',
  'key-end': '#ffffff',
  'boss-kill': '#22d3ee',   // cyan-400
  'boss-wipe': '#dc2626',   // red-600
}

// ---------------------------------------------------------------------------
// Spell IDs — CC
// Must be verified against Midnight Retail patch notes.
// ---------------------------------------------------------------------------

export const SPELL_IDS_CC: ReadonlySet<number> = new Set([
  118, // Polymorph (Mage)
  51514, // Hex (Shaman)
  5782, // Fear (Warlock)
  6770, // Sap (Rogue)
  1776, // Gouge (Rogue)
  408, // Kidney Shot (Rogue)
  1833, // Cheap Shot (Rogue)
  2094, // Blind (Rogue)
  339, // Entangling Roots (Druid)
  33786, // Cyclone (Druid)
  22570, // Maim (Druid)
  9005, // Pounce (Druid)
  19386, // Wyvern Sting (Hunter)
  3355, // Freezing Trap (Hunter)
  710, // Banish (Warlock)
  6358, // Seduction (Warlock)
  30283, // Shadowfury (Warlock)
  853, // Hammer of Justice (Paladin)
  20066, // Repentance (Paladin)
  10326, // Turn Evil (Paladin)
  9484, // Shackle Undead (Priest)
  605, // Mind Control (Priest)
  8122, // Psychic Scream (Priest)
  31935, // Avenger's Shield (Paladin)
  107570, // Storm Bolt (Warrior)
  5246, // Intimidating Shout (Warrior)
  46968, // Shockwave (Warrior)
  119381, // Leg Sweep (Monk)
  115078, // Paralysis (Monk)
  202346, // Double Barrel (Hunter — BM)
  187650, // Freezing Trap (Hunter, second ID)
  162480, // Steel Trap (Hunter)

  // --- Verified against wago.tools game-data build 12.0.1.66838 (see constants.ts
  // spell-verification pass) — spells previously missing from our hand-maintained list.
  99, // Incapacitating Roar (Druid)
  1513, // Scare Beast (Hunter)
  2637, // Hibernate (Druid)
  5211, // Mighty Bash (Druid)
  5484, // Howl of Terror (Warlock)
  6789, // Mortal Coil (Warlock)
  24394, // Intimidation (Hunter pet)
  31661, // Dragon's Breath (Mage)
  82691, // Ring of Frost (Mage)
  88625, // Holy Word: Chastise (Priest)
  89766, // Axe Toss (Warlock pet — Felguard)
  91797, // Monstrous Blow (Hunter pet)
  91800, // Gnaw (Hunter pet)
  105421, // Blinding Light (Paladin)
  117526, // Binding Shot (Hunter)
  118345, // Pulverize (Shaman — Earth Elemental)
  118699, // Fear (Warlock, alt ID)
  118905, // Capacitor Totem (Shaman)
  130616, // Fear (Warlock, alt ID)
  132168, // Shockwave (Warrior, alt ID)
  132169, // Storm Bolt (Warrior, alt ID)
  163505, // Rake (Druid — Feral, stun variant)
  171017, // Meteor Strike (Hunter pet)
  179057, // Chaos Nova (Demon Hunter)
  198909, // Song of Chi-Ji (Monk)
  200166, // Metamorphosis (Demon Hunter — Vengeance)
  200196, // Holy Word: Chastise (Priest, alt ID)
  200200, // Holy Word: Chastise (Priest, alt ID)
  202244, // Overrun (DK pet)
  202274, // Hot Trub (Monk pet)
  203337, // Freezing Trap (Hunter, third ID)
  205290, // Wake of Ashes (Paladin)
  205364, // Dominate Mind (Priest)
  205630, // Illidan's Grasp (Demon Hunter)
  207167, // Blinding Sleet (DK)
  207685, // Sigil of Misery (Demon Hunter)
  210141, // Reanimation (DK pet)
  212332, // Smash (Warrior pet)
  212337, // Powerful Smash (Warrior pet)
  217832, // Imprison (Demon Hunter)
  221562, // Asphyxiate (DK)
  255941, // Wake of Ashes (Paladin, alt ID)
  305485, // Lightning Lasso (Shaman)
  353084, // Ring of Fire (Mage)
  357021, // Consecutive Concussion (Warrior)
  360806, // Sleep Walk (Evoker)
  372245, // Terror of the Skies (Evoker)
  377048, // Absolute Zero (Mage)
  383121, // Mass Polymorph (Mage)
  385954, // Shield Charge (Warrior)
  389831, // Snowdrift (Mage)
  1234195, // Void Nova (Demon Hunter)

  // --- Second verification pass against wago.tools build 12.0.1.66838's
  // diminishingReturns lists (packages/shared/src/data/spellClassMap.json in
  // wowarenalogs) — these spells were already correctly categorized in DR_CATEGORY
  // below, but missing from this set meant CombatLogParser never classified their
  // casts as 'cc' events in the first place, so the DR_CATEGORY entries were
  // unreachable dead data. Includes root/taunt/knockback/silence/disarm DR families
  // that had ~zero coverage, plus common arena CC (Frost Nova, Void Tendrils, Disable).
  122, // Frost Nova (Mage)
  355, // Taunt (Warrior)
  1161, // Challenging Shout (Warrior)
  1330, // Garrote — Silence (Rogue)
  6795, // Growl (Druid/Hunter pet)
  15487, // Silence (Priest — Shadow)
  33395, // Freeze (Mage — Water Elemental)
  51490, // Thunderstorm (Shaman)
  56222, // Dark Command (Death Knight)
  61391, // Typhoon (Druid)
  62124, // Hand of Reckoning (Paladin)
  64695, // Earthgrab (Shaman totem)
  102359, // Mass Entanglement (Hunter)
  106898, // Stampeding Roar (Druid)
  108199, // Gorefiend's Grasp (Death Knight)
  114404, // Void Tendrils (Priest)
  116189, // Provoke (Monk)
  116706, // Disable (Monk, root application)
  132469, // Typhoon (Druid, alt ID)
  136634, // Narrow Escape (Hunter)
  170855, // Entangling Roots (Druid, alt ID)
  185245, // Torment (Demon Hunter)
  199042, // Thunderstruck (Warrior)
  204490, // Sigil of Silence (Demon Hunter)
  207777, // Dismantle (Rogue)
  209749, // Faerie Swarm (Druid)
  212638, // Tracker's Net (Hunter — Survival)
  233759, // Grapple Weapon (Monk)
  236077, // Disarm (Warrior)
  355689, // Landslide (Evoker)
  370970, // The Hunt (Demon Hunter)
  374776, // Tightening Grasp (Evoker)
  386071, // Disrupting Shout (Warrior — Protection; also an interrupt, see SPELL_IDS_INTERRUPT)
  407032, // Sticky Tar Bomb (Hunter — Survival)
  454787, // Ice Prison (Mage)
  1258862, // Encasing Cold (Mage — Frost)
  1277104, // Javelineer (Warrior)

  // --- Trinket/CC-break verification pass (real combat log check) — War Stomp was
  // previously miscategorized as a CC-break; it's actually a stun dealt to enemies.
  20549, // War Stomp (Tauren racial)
])

// ---------------------------------------------------------------------------
// Spell IDs — Defensives
// ---------------------------------------------------------------------------

export const SPELL_IDS_DEFENSIVE: ReadonlySet<number> = new Set([
  // Paladin
  642,   // Divine Shield
  498,   // Divine Protection
  31850, // Ardent Defender
  1022,  // Blessing of Protection
  // Mage
  45438,  // Ice Block
  108978, // Alter Time
  110959, // Greater Invisibility
  235450, // Prismatic Barrier (Arcane)
  414664, // Mass Invisibility
  11426,  // Ice Barrier (Frost)
  235313, // Blazing Barrier (Fire)
  // Hunter
  186265, // Aspect of the Turtle
  109304, // Exhilaration
  5384,   // Feign Death
  // Druid
  22812, // Barkskin
  33891, // Survival Instincts — alternate ID
  61336, // Survival Instincts — primary ID
  22842, // Frenzied Regeneration
  102342, // Ironbark
  // Priest
  47788, // Guardian Spirit
  33206, // Pain Suppression
  47585, // Dispersion
  19236, // Desperate Prayer
  // Rogue
  5277,  // Evasion (primary ID)
  6229,  // Evasion (alternate ID)
  1966,  // Feint
  31224, // Cloak of Shadows
  1856,  // Vanish
  // Warrior
  871,    // Shield Wall
  23920,  // Spell Reflection
  118038, // Die by the Sword
  97462,  // Rallying Cry
  184364, // Enraged Regeneration
  // Monk
  115176, // Zen Meditation
  122278, // Dampen Harm
  122783, // Diffuse Magic
  115203, // Fortifying Brew (Windwalker)
  243435, // Fortifying Brew (Mistweaver)
  // Warlock
  104773, // Unending Resolve
  108416, // Dark Pact
  // Shaman
  108271, // Astral Shift
  198103, // Earth Elemental
  98008,  // Spirit Link Totem
  // Death Knight
  48707, // Anti-Magic Shell
  48792, // Icebound Fortitude
  48743, // Death Pact
  // 49039 Lichborne — removed from defensives in Midnight (no longer reduces damage)
  // Demon Hunter
  198589, // Blur
  // 196555 Netherwalk — removed in Midnight
  196718, // Darkness
  // Evoker
  363916, // Obsidian Scales
  374348, // Renewing Blaze
  374875, // Time Spiral
  370784, // Rescue
  370960, // Zephyr

  // --- Verified against wago.tools game-data build 12.0.1.66838 (see constants.ts
  // spell-verification pass) — defensives previously missing from our hand-maintained list.
  6940,   // Blessing of Sacrifice (Paladin)
  199448, // Blessing of Sacrifice (Paladin, alt ID)
  204018, // Blessing of Spellwarding (Paladin)
  86659,  // Guardian of Ancient Kings (Paladin)
  50322,  // Survival Instincts (Druid, current ID)
  116849, // Life Cocoon (Monk — Mistweaver)
  120954, // Fortifying Brew (Monk, alt ID)
  53480,  // Roar of Sacrifice (Hunter)
  264735, // Survival of the Fittest (Hunter)
  55233,  // Vampiric Blood (Death Knight)
  81549,  // Cloak of Shadows (Rogue, current ID — supersedes 31224)
  212800, // Blur (Demon Hunter, current ID — supersedes 198589)
  207771, // Fiery Brand (Demon Hunter)
  342246, // Alter Time (Mage, current ID — supersedes 108978)
  414658, // Ice Cold (Mage)
  357170, // Time Dilation (Evoker)

  // --- Second verification pass against wago.tools build 12.0.1.66838's
  // "important" spell list (buffs_defensive type) — previously missing.
  1044,   // Blessing of Freedom (Paladin)
  50334,  // Berserk (Druid — Guardian)
  64843,  // Divine Hymn (Priest — Holy)
  110909, // Alter Time (Mage — Arcane, alt ID)
  114052, // Ascendance (Shaman — Restoration)
  132578, // Invoke Niuzao, the Black Ox (Monk — Windwalker)
  187827, // Metamorphosis (Demon Hunter — Vengeance)
  204021, // Fiery Brand (Demon Hunter, alt ID)
  403876, // Divine Protection (Paladin — Holy, alt ID)
  1246965, // Psychic Shroud (Priest)
  55342,  // Mirror Image (Mage)
])

// ---------------------------------------------------------------------------
// Spell IDs — Offensive cooldowns
// ---------------------------------------------------------------------------

export const SPELL_IDS_OFFENSIVE: ReadonlySet<number> = new Set([
  2825, // Bloodlust (Shaman)
  32182, // Heroism (Shaman)
  80353, // Time Warp (Mage)
  264667, // Primal Rage (Hunter — BM)
  390386, // Fury of the Aspects (Evoker)
  12472, // Icy Veins (Mage)
  205021, // Ray of Frost (Mage - Frost)
  365350, // Arcane Surge (Mage - Arcane)
  13750, // Adrenaline Rush (Rogue)
  51271, // Pillar of Frost (DK)
  31884, // Avenging Wrath (Paladin)
  190319, // Combustion (Mage)
  193530, // Aspect of the Wild (Hunter)
  220143, // Mechanics — Aspect of the Eagle (Hunter)
  319454, // Apocalypse (DK Unholy)
  47568, // Empower Rune Weapon (DK)
  107574, // Avatar (Warrior)
  152173, // Serenity (Monk)
  123904, // Invoke Xuen (Monk)
  137639, // Storm, Earth, and Fire (Monk)
  375087, // Dragonrage (Evoker)
  279302, // Frostwyrm's Fury (DK Frost)

  // --- Second verification pass against wago.tools build 12.0.1.66838's
  // "important" spell list (buffs_offensive / debuffs_offensive type) — previously missing.
  49028,  // Dancing Rune Weapon (Death Knight)
  106951, // Berserk (Druid — Feral)
  102543, // Incarnation: Avatar of Ashamane (Druid — Feral)
  102560, // Incarnation: Chosen of Elune (Druid — Balance)
  390414, // Incarnation: Chosen of Elune (Druid — Balance, alt ID)
  102558, // Incarnation: Guardian of Ursoc (Druid — Guardian)
  114051, // Ascendance (Shaman — Enhancement)
  121471, // Shadow Blades (Rogue — Subtlety)
  194223, // Celestial Alignment (Druid — Balance)
  383410, // Celestial Alignment (Druid — Balance, alt ID)
  194249, // Voidform (Priest — Shadow)
  228260, // Voidform (Priest — Shadow, alt ID)
  216331, // Avenging Crusader (Paladin — Holy)
  265187, // Summon Demonic Tyrant (Warlock — Demonology)
  205180, // Summon Darkglare (Warlock — Affliction)
  288613, // Trueshot (Hunter — Marksmanship)
  360194, // Deathmark (Rogue — Assassination)
  365362, // Arcane Surge (Mage — Arcane, alt ID)
  389539, // Sentinel (Paladin — Protection)
  466772, // Doom Winds (Shaman — Enhancement)
  454351, // Avenging Wrath (Paladin — Holy, alt ID)
  454373, // Avenging Wrath (Paladin — Holy, alt ID 2)
  191427, // Metamorphosis (Demon Hunter — Havoc)
])

// ---------------------------------------------------------------------------
// Spell IDs — Interrupts
// ---------------------------------------------------------------------------

export const SPELL_IDS_INTERRUPT: ReadonlySet<number> = new Set([
  2139, // Counterspell (Mage)
  1766, // Kick (Rogue)
  6552, // Pummel (Warrior)
  47528, // Mind Freeze (DK)
  183752, // Disrupt (DH) — comment previously said "Consume Magic", ID was correct
  116705, // Spear Hand Strike (Monk)
  96231, // Rebuke (Paladin)
  57994, // Wind Shear (Shaman)
  19647, // Spell Lock (Warlock — felhunter)
  147362, // Counter Shot (Hunter)
  187707, // Muzzle (Hunter — MM)
  351338, // Quell (Evoker)

  // --- Verified against wago.tools game-data build 12.0.1.66838 (see constants.ts
  // spell-verification pass) — we had zero interrupt coverage for Feral Druid and
  // Shadow Priest, two common arena specs.
  93985,  // Skull Bash (Druid — Feral)
  263715, // Silence (Priest — Shadow)
  171138, // Shadow Lock (Warlock — voidwalker pet, alt to Spell Lock)
  91807,  // Shambling Rush (DK — Unholy pet)
  386071, // Disrupting Shout (Warrior — Protection)
])

// ---------------------------------------------------------------------------
// Spell IDs — CC Breaks (Trinket + PvP talents)
// ---------------------------------------------------------------------------

// PvP trinket and racial CC breaks — shown as 'trinket' event type
export const SPELL_IDS_TRINKET: ReadonlySet<number> = new Set([
  // 42292 ("PvP Trinket") never fires in current combat logs — verified against a real
  // Midnight log line, the actual cast/aura ID is 283167. Kept discovering this required
  // grepping WoWCombatLog-*.txt directly; trinket usage was silently undetected before.
  283167, // PvP Trinket (verified against real log, supersedes stale 42292)
  336126, // Gladiator's Medallion (verified against real log — separate item ID from 283167)
  59752,  // Every Man for Himself (Human racial)
  7744,   // Will of the Forsaken (Undead racial)
])

// Racial CC breaks — verified against real combat log lines (cast + aura-applied,
// same spellId in both). Escape Artist/Fireblood/Stoneform all cleanse CC or reduce
// its duration; distinct from SPELL_IDS_TRINKET, which are full-immunity-style breaks.
export const SPELL_IDS_CC_BREAK: ReadonlySet<number> = new Set([
  20589,  // Escape Artist (Gnome racial) — removes root/snare effects
  273104, // Fireblood (Dark Iron Dwarf racial) — removes all CC effects
  65116,  // Stoneform (Dwarf racial) — removes poison/disease/curse/bleed
])

// ---------------------------------------------------------------------------
// Spell IDs — Full immunities (used by the mistake detector: damage/CC cast into one
// of these is always wasted — the target cannot be affected while the aura is active).
// ---------------------------------------------------------------------------
export const SPELL_IDS_IMMUNITY: ReadonlySet<number> = new Set([
  642,    // Divine Shield (Paladin)
  45438,  // Ice Block (Mage)
  186265, // Aspect of the Turtle (Hunter)
  33786,  // Cyclone (Druid) — target is untargetable/unaffectable while airborne
  710,    // Banish (Warlock, on demon targets)

  // --- Second verification pass against wago.tools build 12.0.1.66838's
  // immunities / immunities_spells lists — previously missing.
  8178,   // Grounding Totem (Shaman) — redirects one harmful spell
  212295, // Nether Ward (Warlock — Demonology) — redirects one harmful spell
  378441, // Time Stop (Evoker — Preservation)
  378464, // Nullifying Shroud (Evoker — Preservation)
  408558, // Phase Shift (Priest)
])

// ---------------------------------------------------------------------------
// Low-value CC — short duration or breaks on damage, not worth using a PvP trinket
// (Every Man for Himself / Will of the Forsaken / PvP Trinket) to escape.
// ---------------------------------------------------------------------------
export const LOW_VALUE_CC_IDS: ReadonlySet<number> = new Set([
  6770, // Sap (Rogue)
  1776, // Gouge (Rogue)
  1330, // Garrote — Silence (Rogue)
])

// ---------------------------------------------------------------------------
// Spell ID → class name mapping for class inference from combat events.
// Covers all tracked spell IDs (CC, defensive, offensive, interrupt, cc-break)
// plus class-specific racial/signature spells seen in arena.
// ---------------------------------------------------------------------------

export const SPELL_CLASS_MAP: Readonly<Record<number, string>> = {
  // Mage
  118: 'Mage',       // Polymorph
  12472: 'Mage',     // Icy Veins
  190319: 'Mage',    // Combustion
  80353: 'Mage',     // Time Warp
  2139: 'Mage',      // Counterspell
  45438: 'Mage',     // Ice Block

  // Rogue
  6770: 'Rogue',     // Sap
  1776: 'Rogue',     // Gouge
  408: 'Rogue',      // Kidney Shot
  1833: 'Rogue',     // Cheap Shot
  2094: 'Rogue',     // Blind
  1766: 'Rogue',     // Kick
  6229: 'Rogue',     // Evasion
  1966: 'Rogue',     // Feint
  31224: 'Rogue',    // Cloak of Shadows
  13750: 'Rogue',    // Adrenaline Rush

  // Druid
  339: 'Druid',      // Entangling Roots
  33786: 'Druid',    // Cyclone
  22570: 'Druid',    // Maim
  9005: 'Druid',     // Pounce
  22812: 'Druid',    // Barkskin
  33891: 'Druid',    // Survival Instincts

  // Shaman
  51514: 'Shaman',   // Hex
  57994: 'Shaman',   // Wind Shear
  2825: 'Shaman',    // Bloodlust
  32182: 'Shaman',   // Heroism

  // Warlock
  5782: 'Warlock',   // Fear
  710: 'Warlock',    // Banish
  6358: 'Warlock',   // Seduction
  30283: 'Warlock',  // Shadowfury
  104773: 'Warlock', // Unending Resolve
  108416: 'Warlock', // Dark Pact
  19647: 'Warlock',  // Spell Lock

  // Paladin
  853: 'Paladin',    // Hammer of Justice
  20066: 'Paladin',  // Repentance
  10326: 'Paladin',  // Turn Evil
  31935: 'Paladin',  // Avenger's Shield
  642: 'Paladin',    // Divine Shield
  96231: 'Paladin',  // Rebuke
  31884: 'Paladin',  // Avenging Wrath

  // Priest
  9484: 'Priest',    // Shackle Undead
  605: 'Priest',     // Mind Control
  8122: 'Priest',    // Psychic Scream
  47788: 'Priest',   // Guardian Spirit
  33206: 'Priest',   // Pain Suppression

  // Warrior
  107570: 'Warrior', // Storm Bolt
  5246: 'Warrior',   // Intimidating Shout
  46968: 'Warrior',  // Shockwave
  871: 'Warrior',    // Shield Wall
  23920: 'Warrior',  // Spell Reflection
  118038: 'Warrior', // Die by the Sword
  6552: 'Warrior',   // Pummel
  107574: 'Warrior', // Avatar

  // Monk
  119381: 'Monk',    // Leg Sweep
  115078: 'Monk',    // Paralysis
  115176: 'Monk',    // Zen Meditation
  122278: 'Monk',    // Dampen Harm
  122783: 'Monk',    // Diffuse Magic
  116705: 'Monk',    // Spear Hand Strike
  152173: 'Monk',    // Serenity
  123904: 'Monk',    // Invoke Xuen
  137639: 'Monk',    // Storm, Earth, and Fire

  // Hunter
  19386: 'Hunter',   // Wyvern Sting
  3355: 'Hunter',    // Freezing Trap
  186265: 'Hunter',  // Aspect of the Turtle
  193530: 'Hunter',  // Aspect of the Wild
  147362: 'Hunter',  // Counter Shot
  187707: 'Hunter',  // Muzzle
  202346: 'Hunter',  // Double Barrel
  187650: 'Hunter',  // Freezing Trap (alt)
  162480: 'Hunter',  // Steel Trap
  264667: 'Hunter',  // Primal Rage

  // Death Knight
  47528: 'Death Knight',  // Mind Freeze
  51271: 'Death Knight',  // Pillar of Frost
  279302: 'Death Knight', // Frostwyrm's Fury
  47568: 'Death Knight',  // Empower Rune Weapon
  319454: 'Death Knight', // Apocalypse
  48707: 'Death Knight',  // Anti-Magic Shell
  48792: 'Death Knight',  // Icebound Fortitude
  48743: 'Death Knight',  // Death Pact

  // Demon Hunter
  183752: 'Demon Hunter', // Consume Magic
  198589: 'Demon Hunter', // Blur
  // 196555 Netherwalk removed in Midnight
  196718: 'Demon Hunter', // Darkness
  187827: 'Demon Hunter', // Metamorphosis

  // Evoker
  351338: 'Evoker',  // Quell
  375087: 'Evoker',  // Dragonrage
  390386: 'Evoker',  // Fury of the Aspects
  363916: 'Evoker',  // Obsidian Scales
  374348: 'Evoker',  // Renewing Blaze
  374875: 'Evoker',  // Time Spiral
  370960: 'Evoker',  // Zephyr

  // Hunter (additions)
  109304: 'Hunter',  // Exhilaration
  5384:   'Hunter',  // Feign Death

  // Mage (additions)
  108978: 'Mage',  // Alter Time
  110959: 'Mage',  // Greater Invisibility
  235450: 'Mage',  // Prismatic Barrier
  414664: 'Mage',  // Mass Invisibility
  11426:  'Mage',  // Ice Barrier
  235313: 'Mage',  // Blazing Barrier
  205021: 'Mage',  // Ray of Frost
  365350: 'Mage',  // Arcane Surge

  // Monk (additions)
  115203: 'Monk',  // Fortifying Brew (Windwalker)
  243435: 'Monk',  // Fortifying Brew (Mistweaver)

  // Paladin (additions)
  498:   'Paladin', // Divine Protection
  31850: 'Paladin', // Ardent Defender
  1022:  'Paladin', // Blessing of Protection
  633:   'Paladin', // Lay on Hands

  // Priest (additions)
  47585: 'Priest',  // Dispersion
  19236: 'Priest',  // Desperate Prayer
  62618: 'Priest',  // Power Word: Barrier

  // Rogue (additions)
  5277: 'Rogue',  // Evasion (primary ID)
  1856: 'Rogue',  // Vanish

  // Shaman (additions)
  108271: 'Shaman', // Astral Shift
  198103: 'Shaman', // Earth Elemental
  98008:  'Shaman', // Spirit Link Totem

  // Warrior (additions)
  97462:  'Warrior', // Rallying Cry
  184364: 'Warrior', // Enraged Regeneration

  // --- Verified against wago.tools game-data build 12.0.1.66838 (see constants.ts
  // spell-verification pass) — class attribution for newly-added CC/defensive/interrupt IDs.
  // Death Knight
  91797: 'Death Knight',  // Monstrous Blow
  91800: 'Death Knight',  // Gnaw
  207167: 'Death Knight', // Blinding Sleet
  210141: 'Death Knight', // Reanimation
  212332: 'Death Knight', // Smash
  212337: 'Death Knight', // Powerful Smash
  221562: 'Death Knight', // Asphyxiate
  377048: 'Death Knight', // Absolute Zero
  55233: 'Death Knight',  // Vampiric Blood
  91807: 'Death Knight',  // Shambling Rush

  // Demon Hunter
  179057: 'Demon Hunter',  // Chaos Nova
  200166: 'Demon Hunter',  // Metamorphosis
  205630: 'Demon Hunter',  // Illidan's Grasp
  207685: 'Demon Hunter',  // Sigil of Misery
  217832: 'Demon Hunter',  // Imprison
  1234195: 'Demon Hunter', // Void Nova
  207771: 'Demon Hunter',  // Fiery Brand
  212800: 'Demon Hunter',  // Blur (current ID)

  // Druid
  99: 'Druid',      // Incapacitating Roar
  2637: 'Druid',    // Hibernate
  5211: 'Druid',    // Mighty Bash
  163505: 'Druid',  // Rake
  202244: 'Druid',  // Overrun
  50322: 'Druid',   // Survival Instincts (current ID)
  93985: 'Druid',   // Skull Bash

  // Evoker
  360806: 'Evoker', // Sleep Walk
  372245: 'Evoker', // Terror of the Skies
  357170: 'Evoker', // Time Dilation

  // Hunter
  1513: 'Hunter',    // Scare Beast
  24394: 'Hunter',   // Intimidation
  117526: 'Hunter',  // Binding Shot
  203337: 'Hunter',  // Freezing Trap (alt)
  357021: 'Hunter',  // Consecutive Concussion
  53480: 'Hunter',   // Roar of Sacrifice
  264735: 'Hunter',  // Survival of the Fittest

  // Mage
  31661: 'Mage',   // Dragon's Breath
  82691: 'Mage',   // Ring of Frost
  353084: 'Mage',  // Ring of Fire
  383121: 'Mage',  // Mass Polymorph
  389831: 'Mage',  // Snowdrift
  342246: 'Mage',  // Alter Time (current ID)
  414658: 'Mage',  // Ice Cold
  386770: 'Mage',  // Freezing Cold
  454787: 'Mage',  // Ice Prison
  1258862: 'Mage', // Encasing Cold

  // Monk
  198909: 'Monk',  // Song of Chi-Ji
  202274: 'Monk',  // Hot Trub
  116849: 'Monk',  // Life Cocoon
  120954: 'Monk',  // Fortifying Brew (alt ID)

  // Paladin
  105421: 'Paladin', // Blinding Light
  205290: 'Paladin', // Wake of Ashes
  255941: 'Paladin', // Wake of Ashes (alt ID)
  6940: 'Paladin',   // Blessing of Sacrifice
  86659: 'Paladin',  // Guardian of Ancient Kings
  199448: 'Paladin', // Blessing of Sacrifice (alt ID)
  204018: 'Paladin', // Blessing of Spellwarding

  // Priest
  88625: 'Priest',  // Holy Word: Chastise
  200196: 'Priest', // Holy Word: Chastise (alt ID)
  200200: 'Priest', // Holy Word: Chastise (alt ID)
  205364: 'Priest', // Dominate Mind
  263715: 'Priest', // Silence

  // Rogue
  81549: 'Rogue', // Cloak of Shadows (current ID)

  // Shaman
  118345: 'Shaman', // Pulverize (Earth Elemental)
  118905: 'Shaman', // Capacitor Totem
  305485: 'Shaman', // Lightning Lasso

  // Warlock
  5484: 'Warlock',   // Howl of Terror
  6789: 'Warlock',   // Mortal Coil
  89766: 'Warlock',  // Axe Toss
  118699: 'Warlock', // Fear (alt ID)
  130616: 'Warlock', // Fear (alt ID)
  171017: 'Warlock', // Meteor Strike
  171138: 'Warlock', // Shadow Lock

  // Warrior
  132168: 'Warrior', // Shockwave (alt ID)
  132169: 'Warrior', // Storm Bolt (alt ID)
  385954: 'Warrior', // Shield Charge
  386071: 'Warrior', // Disrupting Shout

  // --- Second verification pass against wago.tools build 12.0.1.66838 — class
  // attribution for the DR-tracked CC spells added to SPELL_IDS_CC above.
  122: 'Mage',           // Frost Nova
  355: 'Warrior',        // Taunt
  1161: 'Warrior',       // Challenging Shout
  1330: 'Rogue',         // Garrote — Silence
  6795: 'Druid',         // Growl
  15487: 'Priest',       // Silence
  33395: 'Mage',         // Freeze (Water Elemental)
  51490: 'Shaman',       // Thunderstorm
  56222: 'Death Knight', // Dark Command
  61391: 'Druid',        // Typhoon
  62124: 'Paladin',      // Hand of Reckoning
  64695: 'Shaman',       // Earthgrab
  102359: 'Druid',       // Mass Entanglement
  106898: 'Druid',       // Stampeding Roar
  108199: 'Death Knight', // Gorefiend's Grasp
  114404: 'Priest',      // Void Tendrils
  116189: 'Monk',        // Provoke
  116706: 'Monk',        // Disable
  132469: 'Druid',       // Typhoon (alt ID)
  136634: 'Hunter',      // Narrow Escape
  170855: 'Druid',       // Entangling Roots (alt ID)
  185245: 'Demon Hunter', // Torment
  199042: 'Warrior',     // Thunderstruck
  204490: 'Demon Hunter', // Sigil of Silence
  207777: 'Rogue',       // Dismantle
  209749: 'Druid',       // Faerie Swarm
  212638: 'Hunter',      // Tracker's Net
  233759: 'Monk',        // Grapple Weapon
  236077: 'Warrior',     // Disarm
  355689: 'Evoker',      // Landslide
  370970: 'Demon Hunter', // The Hunt
  374776: 'Death Knight', // Tightening Grasp
  407032: 'Hunter',      // Sticky Tar Bomb
  1277104: 'Warrior',    // Javelineer

  // Offensive/defensive/immunity additions from the same verification pass
  49028: 'Death Knight',  // Dancing Rune Weapon
  106951: 'Druid',        // Berserk (Feral)
  102543: 'Druid',        // Incarnation: Avatar of Ashamane
  102560: 'Druid',        // Incarnation: Chosen of Elune
  390414: 'Druid',        // Incarnation: Chosen of Elune (alt ID)
  102558: 'Druid',        // Incarnation: Guardian of Ursoc
  114051: 'Shaman',       // Ascendance (Enhancement)
  121471: 'Rogue',        // Shadow Blades
  194223: 'Druid',        // Celestial Alignment
  383410: 'Druid',        // Celestial Alignment (alt ID)
  194249: 'Priest',       // Voidform
  228260: 'Priest',       // Voidform (alt ID)
  216331: 'Paladin',      // Avenging Crusader
  265187: 'Warlock',      // Summon Demonic Tyrant
  205180: 'Warlock',      // Summon Darkglare
  288613: 'Hunter',       // Trueshot
  360194: 'Rogue',        // Deathmark
  365362: 'Mage',         // Arcane Surge (alt ID)
  389539: 'Paladin',      // Sentinel
  466772: 'Shaman',       // Doom Winds
  454351: 'Paladin',      // Avenging Wrath (alt ID)
  454373: 'Paladin',      // Avenging Wrath (alt ID 2)
  191427: 'Demon Hunter', // Metamorphosis (Havoc)
  1044: 'Paladin',        // Blessing of Freedom
  50334: 'Druid',         // Berserk (Guardian)
  64843: 'Priest',        // Divine Hymn
  110909: 'Mage',         // Alter Time (alt ID)
  114052: 'Shaman',       // Ascendance (Restoration)
  132578: 'Monk',         // Invoke Niuzao, the Black Ox
  204021: 'Demon Hunter', // Fiery Brand (alt ID)
  403876: 'Paladin',      // Divine Protection (alt ID)
  1246965: 'Priest',      // Psychic Shroud
  55342: 'Mage',          // Mirror Image
  8178: 'Shaman',         // Grounding Totem
  212295: 'Warlock',      // Nether Ward
  378441: 'Evoker',       // Time Stop
  378464: 'Evoker',       // Nullifying Shroud
  408558: 'Priest',       // Phase Shift
}

// ---------------------------------------------------------------------------
// Spell ID → spec name (short) for spec inference.
// Only includes spells that are uniquely diagnostic of one spec.
// Healer specs are inferred separately from healer detection + class.
// ---------------------------------------------------------------------------

export const SPELL_SPEC_MAP: Readonly<Record<number, string>> = {
  // Mage
  190319: 'Fire',       // Combustion
  12472: 'Frost',       // Icy Veins
  205021: 'Frost',      // Ray of Frost
  365350: 'Arcane',     // Arcane Surge
  11426:  'Frost',      // Ice Barrier
  235313: 'Fire',       // Blazing Barrier

  // Rogue
  13750: 'Outlaw',      // Adrenaline Rush

  // Druid
  22570: 'Feral',       // Maim

  // Monk
  137639: 'Windwalker', // Storm, Earth, and Fire
  152173: 'Windwalker', // Serenity
  123904: 'Windwalker', // Invoke Xuen

  // Death Knight
  51271: 'Frost',       // Pillar of Frost
  319454: 'Unholy',     // Apocalypse
  47568: 'Unholy',      // Empower Rune Weapon (also Frost but paired above)

  // Priest — only truly spec-exclusive abilities
  33206: 'Discipline',  // Pain Suppression (Disc only)
  47788: 'Holy',        // Guardian Spirit (Holy only)
  // Psychic Scream is baseline for ALL Priest specs — NOT here

  // Warrior
  107574: 'Arms',       // Avatar (Arms in PvP)

  // Evoker
  375087: 'Devastation', // Dragonrage
  390386: 'Devastation', // Fury of the Aspects

  // Demon Hunter — Havoc is the only arena spec
  183752: 'Havoc',      // Consume Magic
  // Avenging Wrath removed — used by all Paladin specs
  // Empower Rune Weapon removed — used by both DK specs
}

// Healer spec by class — used when a player is confirmed as a healer.
export const HEALER_SPEC_BY_CLASS: Readonly<Record<string, string>> = {
  'Druid': 'Restoration',
  'Paladin': 'Holy',
  'Priest': 'Discipline', // default; overridden if Guardian Spirit detected
  'Shaman': 'Restoration',
  'Monk': 'Mistweaver',
  'Evoker': 'Preservation',
}

// ---------------------------------------------------------------------------
// WoW spec ID → { spec, class } map.
// Source: https://warcraft.wiki.gg/wiki/SpecializationID
// Used to resolve COMBATANT_INFO trailing specID field into spec + class names.
// ---------------------------------------------------------------------------
export const WOW_SPEC_ID_MAP: Readonly<Record<number, { spec: string; class: string; isHealer: boolean }>> = {
  // Death Knight
  250: { spec: 'Blood',     class: 'Death Knight', isHealer: false },
  251: { spec: 'Frost',     class: 'Death Knight', isHealer: false },
  252: { spec: 'Unholy',    class: 'Death Knight', isHealer: false },
  // Demon Hunter
  577: { spec: 'Havoc',     class: 'Demon Hunter', isHealer: false },
  581: { spec: 'Vengeance', class: 'Demon Hunter', isHealer: false },
  // Druid
  102: { spec: 'Balance',      class: 'Druid', isHealer: false },
  103: { spec: 'Feral',        class: 'Druid', isHealer: false },
  104: { spec: 'Guardian',     class: 'Druid', isHealer: false },
  105: { spec: 'Restoration',  class: 'Druid', isHealer: true  },
  // Evoker
  1467: { spec: 'Devastation', class: 'Evoker', isHealer: false },
  1468: { spec: 'Preservation',class: 'Evoker', isHealer: true  },
  1473: { spec: 'Augmentation',class: 'Evoker', isHealer: false },
  // Hunter
  253: { spec: 'Beast Mastery',   class: 'Hunter', isHealer: false },
  254: { spec: 'Marksmanship',    class: 'Hunter', isHealer: false },
  255: { spec: 'Survival',        class: 'Hunter', isHealer: false },
  // Mage
  62: { spec: 'Arcane', class: 'Mage', isHealer: false },
  63: { spec: 'Fire',   class: 'Mage', isHealer: false },
  64: { spec: 'Frost',  class: 'Mage', isHealer: false },
  // Monk
  268: { spec: 'Brewmaster', class: 'Monk', isHealer: false },
  269: { spec: 'Windwalker', class: 'Monk', isHealer: false },
  270: { spec: 'Mistweaver', class: 'Monk', isHealer: true  },
  // Paladin
  65: { spec: 'Holy',         class: 'Paladin', isHealer: true  },
  66: { spec: 'Protection',   class: 'Paladin', isHealer: false },
  70: { spec: 'Retribution',  class: 'Paladin', isHealer: false },
  // Priest
  256: { spec: 'Discipline', class: 'Priest', isHealer: true  },
  257: { spec: 'Holy',       class: 'Priest', isHealer: true  },
  258: { spec: 'Shadow',     class: 'Priest', isHealer: false },
  // Rogue
  259: { spec: 'Assassination', class: 'Rogue', isHealer: false },
  260: { spec: 'Outlaw',        class: 'Rogue', isHealer: false },
  261: { spec: 'Subtlety',      class: 'Rogue', isHealer: false },
  // Shaman
  262: { spec: 'Elemental',   class: 'Shaman', isHealer: false },
  263: { spec: 'Enhancement', class: 'Shaman', isHealer: false },
  264: { spec: 'Restoration', class: 'Shaman', isHealer: true  },
  // Warlock
  265: { spec: 'Affliction',  class: 'Warlock', isHealer: false },
  266: { spec: 'Demonology',  class: 'Warlock', isHealer: false },
  267: { spec: 'Destruction', class: 'Warlock', isHealer: false },
  // Warrior
  71: { spec: 'Arms',       class: 'Warrior', isHealer: false },
  72: { spec: 'Fury',       class: 'Warrior', isHealer: false },
  73: { spec: 'Protection', class: 'Warrior', isHealer: false },
}

// ---------------------------------------------------------------------------
// DR (Diminishing Returns) category map
// spellId → DR category string. Spells sharing the same category share DR.
// WoW DR mechanic (Midnight): 100% → 50% → immune (3 stages).
// Flag when a cast would land at immune (≥2 prior applications in the 18s window).
// DR window: 18 seconds measured from when the AURA expired (SPELL_AURA_REMOVED).
// ---------------------------------------------------------------------------

// Category values match Blizzard's actual 8 DR categories exactly (verified against
// wago.tools game-data build 12.0.1.66838 — see constants.ts spell-verification pass).
// IMPORTANT FIX: this map previously used made-up category names ('fear', 'horror',
// 'cyclone', 'blind') for spells that in-game actually share the SAME 'disorient' DR
// pool as Polymorph/Hex/etc. — e.g. a Fear followed by a Cyclone within the 18s window
// should have DR'd against each other but didn't, because our code treated them as
// unrelated categories. All four are now merged into 'disorient' below.
export const DR_CATEGORY: Readonly<Record<number, string>> = {
  // Disorient (Polymorph / Hex / Fear / Cyclone / Blind family — all share one DR pool)
  118: 'disorient',    // Polymorph
  161355: 'disorient', // Polymorph (Black Cat)
  28271: 'disorient',  // Polymorph (Turtle)
  28272: 'disorient',  // Polymorph (Pig)
  61025: 'disorient',  // Polymorph (Serpent)
  61305: 'disorient',  // Polymorph (Black Cat)
  383121: 'disorient', // Mass Polymorph (Mage)
  51514: 'disorient',  // Hex
  211015: 'disorient', // Hex (Skeletal Hatchling)
  211010: 'disorient', // Hex (Snake)
  277778: 'disorient', // Hex (Zandalari Tendonripper)
  3355: 'disorient',   // Freezing Trap
  187650: 'disorient', // Freezing Trap (alt)
  203337: 'disorient', // Freezing Trap (alt 2)
  19386: 'disorient',  // Wyvern Sting
  20066: 'disorient',  // Repentance
  9484: 'disorient',   // Shackle Undead / Shackle Horror
  2637: 'disorient',   // Hibernate (Druid)
  5782: 'disorient',   // Fear (Warlock)
  118699: 'disorient', // Fear (Warlock, alt ID)
  130616: 'disorient', // Fear (Warlock, alt ID)
  6358: 'disorient',   // Seduction (Warlock)
  5246: 'disorient',   // Intimidating Shout (Warrior)
  5484: 'disorient',   // Howl of Terror (Warlock)
  8122: 'disorient',   // Psychic Scream (Priest)
  605: 'disorient',    // Mind Control (Priest)
  205364: 'disorient', // Dominate Mind (Priest)
  64044: 'disorient',  // Psychic Horror (Priest)
  33786: 'disorient',  // Cyclone (Druid)
  2094: 'disorient',   // Blind (Rogue)
  10326: 'disorient',  // Turn Evil (Paladin)
  31661: 'disorient',  // Dragon's Breath (Mage)
  105421: 'disorient', // Blinding Light (Paladin)
  198909: 'disorient', // Song of Chi-Ji (Monk)
  360806: 'disorient', // Sleep Walk (Evoker)
  207167: 'disorient', // Blinding Sleet (DK)
  207685: 'disorient', // Sigil of Misery (Demon Hunter)
  202274: 'disorient', // Hot Trub (Monk pet)

  // Stun
  408: 'stun',         // Kidney Shot
  1833: 'stun',        // Cheap Shot
  853: 'stun',         // Hammer of Justice
  119381: 'stun',      // Leg Sweep
  107570: 'stun',      // Storm Bolt
  132169: 'stun',      // Storm Bolt (alt ID)
  46968: 'stun',       // Shockwave (Warrior)
  132168: 'stun',      // Shockwave (Warrior, alt ID)
  5211: 'stun',        // Bash / Mighty Bash (Druid)
  22570: 'stun',       // Maim (Druid)
  9005: 'stun',        // Pounce (Druid)
  163505: 'stun',      // Rake (Druid — Feral, stun variant)
  24394: 'stun',       // Intimidation (Hunter pet)
  89766: 'stun',       // Axe Toss (Warlock pet)
  91797: 'stun',       // Monstrous Blow (Hunter pet)
  91800: 'stun',       // Gnaw (Hunter pet)
  117526: 'stun',      // Binding Shot (Hunter)
  118345: 'stun',      // Pulverize (Shaman — Earth Elemental)
  118905: 'stun',      // Capacitor Totem (Shaman)
  171017: 'stun',      // Meteor Strike (Hunter pet)
  179057: 'stun',      // Chaos Nova (Demon Hunter)
  200166: 'stun',      // Metamorphosis (Demon Hunter — Vengeance)
  200200: 'stun',      // Holy Word: Chastise (Priest, stun variant)
  202244: 'stun',      // Overrun (DK pet)
  202346: 'stun',      // Double Barrel (Hunter — BM)
  205290: 'stun',      // Wake of Ashes (Paladin)
  255941: 'stun',      // Wake of Ashes (Paladin, alt ID)
  205630: 'stun',      // Illidan's Grasp (Demon Hunter)
  210141: 'stun',      // Reanimation (DK pet)
  212332: 'stun',      // Smash (Warrior pet)
  212337: 'stun',      // Powerful Smash (Warrior pet)
  221562: 'stun',      // Asphyxiate (DK)
  305485: 'stun',      // Lightning Lasso (Shaman)
  357021: 'stun',      // Consecutive Concussion (Warrior)
  372245: 'stun',      // Terror of the Skies (Evoker)
  377048: 'stun',      // Absolute Zero (Mage)
  385954: 'stun',      // Shield Charge (Warrior)
  389831: 'stun',      // Snowdrift (Mage)
  1234195: 'stun',     // Void Nova (Demon Hunter)
  30283: 'stun',       // Shadowfury (Warlock)
  20549: 'stun',       // War Stomp (Tauren racial) — verified against real log: applies a
                       // DEBUFF on the target, i.e. it's CC dealt, not a self CC-break like
                       // it was previously (mis)categorized as

  // Incapacitate
  6770: 'incapacitate', // Sap
  1776: 'incapacitate', // Gouge
  710: 'incapacitate',  // Banish
  99: 'incapacitate',   // Incapacitating Roar (Druid)
  1513: 'incapacitate', // Scare Beast (Hunter)
  6789: 'incapacitate', // Mortal Coil (Warlock)
  82691: 'incapacitate', // Ring of Frost (Mage)
  88625: 'incapacitate', // Holy Word: Chastise (Priest, incap variant)
  200196: 'incapacitate', // Holy Word: Chastise (Priest, alt ID)
  115078: 'incapacitate', // Paralysis (Monk)
  217832: 'incapacitate', // Imprison (Demon Hunter)
  353084: 'incapacitate', // Ring of Fire (Mage)

  // Root
  339: 'root',          // Entangling Roots
  170855: 'root',       // Entangling Roots (alt ID)
  33395: 'root',        // Freeze (Water Elemental)
  122: 'root',          // Frost Nova
  64695: 'root',        // Earthgrab (Shaman totem)
  102359: 'root',       // Mass Entanglement (Hunter)
  114404: 'root',       // Void Tendrils (Warlock)
  116706: 'root',       // Disable (Monk, root application)
  136634: 'root',       // Narrow Escape (Hunter trap)
  199042: 'root',       // Thunderstruck (Warrior)
  212638: 'root',       // Tracker's Net (Hunter)
  355689: 'root',       // Landslide (Evoker)
  370970: 'root',       // The Hunt (Evoker)
  386770: 'root',       // Freezing Cold (Mage)
  454787: 'root',       // Ice Prison (Mage)
  1258862: 'root',      // Encasing Cold (Mage)

  // Taunt (low arena relevance — no tanks in most comps — kept for completeness)
  355: 'taunt',      // Taunt (Warrior)
  1161: 'taunt',     // Challenging Shout (Warrior)
  6795: 'taunt',     // Growl (Druid/Hunter pet)
  56222: 'taunt',    // Dark Command (Death Knight)
  62124: 'taunt',    // Hand of Reckoning (Paladin)
  106898: 'taunt',   // Stampeding Roar (Druid)
  116189: 'taunt',   // Provoke (Monk)
  185245: 'taunt',   // Torment (Demon Hunter)
  386071: 'taunt',   // Disrupting Shout (Warrior — Protection)

  // Knockback
  51490: 'knockback',  // Thunderstorm (Shaman)
  61391: 'knockback',  // Typhoon (Druid)
  132469: 'knockback', // Typhoon (Druid, alt ID)
  108199: 'knockback', // Gorefiend's Grasp (Death Knight)

  // Silence
  1330: 'silence',    // Garrote — Silence (Rogue)
  15487: 'silence',   // Silence (Priest — Shadow)
  31935: 'silence',   // Avenger's Shield (Paladin)
  204490: 'silence',  // Sigil of Silence (Demon Hunter)
  374776: 'silence',  // Tightening Grasp (Evoker)
  1277104: 'silence', // Javelineer (Warrior)

  // Disarm
  207777: 'disarm',   // Dismantle (Rogue)
  209749: 'disarm',   // Faerie Swarm (Druid)
  233759: 'disarm',   // Grapple Weapon (Monk)
  236077: 'disarm',   // Disarm (Warrior)
  407032: 'disarm',   // Sticky Tar Bomb (Hunter)
}

// ---------------------------------------------------------------------------
// App defaults
// ---------------------------------------------------------------------------

// HOME is only available in the main process; renderer must never access this.
// typeof guard prevents a ReferenceError when the renderer imports this module.
export const DEFAULT_STORAGE_PATH = (() => {
  if (typeof process === 'undefined') return '~/Movies/Depleted'
  if (process.platform === 'win32') {
    return `${process.env?.USERPROFILE ?? 'C:\\Users\\User'}\\Videos\\Depleted`
  }
  return `${process.env?.HOME ?? '~'}/Movies/Depleted`
})()
export const DEFAULT_VIDEO_BITRATE_KBPS = 8000
export const DEFAULT_VIDEO_FPS = 30
// Directory that holds WoW combat logs (relative to wowPath)
export const COMBAT_LOG_RELATIVE_DIR = '_retail_/Logs'
// Glob pattern used to watch for any WoWCombatLog file (fixed name or timestamped)
export const COMBAT_LOG_GLOB = 'WoWCombatLog*.txt'
// Legacy: kept for tests that reference the old constant
export const COMBAT_LOG_RELATIVE_PATH = '_retail_/Logs/WoWCombatLog.txt'

// Default capture source hint — 'auto' means auto-detect the WoW window by title
// (see src/main/recorder/sourceResolver.ts). Settings can override this with a
// specific desktopCapturer source name for manual selection.
export const DEFAULT_CAPTURE_SOURCE_HINT = 'auto'
export const DEFAULT_VIDEO_RESOLUTION = 'native'
export const DEFAULT_MINIMIZE_TO_TRAY = true
// Companion addon folder / SavedVariables file name (was ArenaRecorderCompanion before 2.0.0)
export const ADDON_NAME = 'DepletedCompanion'
export const ADDON_RELATIVE_PATH = `_retail_/Interface/AddOns/${ADDON_NAME}`

// Bump whenever the addon's SavedVariables contract changes in a way the app depends
// on (e.g. new fields it reads). DepletedCompanion.lua writes its own version into
// DepletedDB.character.version — if that's missing or older than this, the
// installed addon predates a feature the app needs and the user should be prompted to
// update it (see system:getAddonStatus's needsUpdate flag).
export const MIN_ADDON_VERSION = '2.0.0'

// How stale DepletedDB.character.updated (written on PLAYER_LOGIN /
// PLAYER_ENTERING_WORLD / spec change) can be before "connected" is no longer trusted.
// WoW only flushes SavedVariables to disk on logout/reload/exit, but the in-memory
// `updated` timestamp itself only changes on those frequent in-game events, so this
// mainly catches "game was quit N days ago and never reloaded since" rather than normal
// play gaps.
export const ADDON_STALE_MS = 30 * 60 * 1000 // 30 minutes

export const DEFAULT_STATS_SITE: import('./ipc.types').StatsSite = 'checkpvp'
export const DEFAULT_WOW_REGION: import('./ipc.types').WowRegion = 'eu'

// ---------------------------------------------------------------------------
// Class colours (WoW official palette)
// ---------------------------------------------------------------------------

export const CLASS_COLORS: Readonly<Record<string, string>> = {
  'Death Knight': '#C41E3A',
  'Demon Hunter': '#A330C9',
  'Druid': '#FF7C0A',
  'Evoker': '#33937F',
  'Hunter': '#AAD372',
  'Mage': '#3FC7EB',
  'Monk': '#00FF98',
  'Paladin': '#F48CBA',
  'Priest': '#FFFFFF',
  'Rogue': '#FFF468',
  'Shaman': '#0070DD',
  'Warlock': '#8788EE',
  'Warrior': '#C69B3A',
}
