// Application-wide constants. No magic numbers in the codebase — define them here.
// Zone IDs and spell IDs must be verified against the current Midnight patch notes.

// ---------------------------------------------------------------------------
// Mythic+ recording
// ---------------------------------------------------------------------------

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
  'death-player': '#ef4444', // red-500
  interrupt: '#22c55e',     // green-500
  'key-start': '#ffffff',
  'key-end': '#ffffff',
  'boss-kill': '#22d3ee',   // cyan-400
  'boss-wipe': '#dc2626',   // red-600
}

// ---------------------------------------------------------------------------
// Spell ID → class name mapping for class inference from combat events.
// Covers common CC, defensive, offensive and interrupt spells plus class signature
// spells.
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
export const DEFAULT_VIDEO_BITRATE_KBPS = 30000
export const DEFAULT_VIDEO_CODEC = 'hevc' as const
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

export const DEFAULT_STATS_SITE: import('./ipc.types').StatsSite = 'raiderio'
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
