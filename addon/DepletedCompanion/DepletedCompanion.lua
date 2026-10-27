-- DepletedCompanion (formerly ArenaRecorderCompanion)
-- 1. Writes your character's GUID, name, realm, class and spec to SavedVariables
--    so the Depleted desktop app can tell which party member you are.
-- 2. Automatically enables combat logging when you enter a dungeon and when a
--    Mythic+ key starts, so the app always has a log to follow — even if you
--    forgot to type /combatlog.
--
-- SavedVariables file location:
--   WTF/Account/<AccountName>/SavedVariables/DepletedCompanion.lua
--
-- The desktop app reads this file on startup and whenever it changes.

DepletedDB = DepletedDB or {}

local ADDON_VERSION = "2.1.0"

-- ---------------------------------------------------------------------------
-- Character info
-- ---------------------------------------------------------------------------

local function SaveCharacterInfo()
    local name = UnitName("player")
    if not name then return end

    local realm = GetNormalizedRealmName() or GetRealmName() or ""
    local _, className = UnitClass("player")
    local guid = UnitGUID("player") or ""

    local specIndex = GetSpecialization()
    local specName = ""
    if specIndex then
        local _, sn = GetSpecializationInfo(specIndex)
        specName = sn or ""
    end

    DepletedDB.character = {
        guid      = guid,
        name      = name,
        realm     = realm,
        fullName  = name .. "-" .. realm,
        class     = className or "",
        spec      = specName,
        -- Refreshed on every login / zone change / spec change — the desktop app uses
        -- how recent this is to tell "addon connected" from "haven't played in days",
        -- since WoW only flushes SavedVariables on logout/reload, not continuously.
        updated   = date("%Y-%m-%dT%H:%M:%S"),
        version   = ADDON_VERSION,
    }
end

-- ---------------------------------------------------------------------------
-- Combat logging
-- ---------------------------------------------------------------------------

local PREFIX = "|cff2dd4bfDepleted|r"

-- Ensures combat logging is active. Called on entering a dungeon and when a key
-- starts, so the desktop app sees CHALLENGE_MODE_START.
local function EnsureCombatLogging()
    if not LoggingCombat() then
        LoggingCombat(true)
        print(PREFIX .. " Combat logging enabled.")
    end
end

-- Returns true inside a 5-player dungeon (where Mythic+ happens).
local function IsInRecordableInstance()
    local _, instanceType = IsInInstance()
    return instanceType == "party"
end

-- ---------------------------------------------------------------------------
-- Slash command: /depleted
-- ---------------------------------------------------------------------------

local function PrintAbout()
    print(" ")
    print(PREFIX .. " Companion v" .. ADDON_VERSION)
    print("|cffaaaaaa----------------------------------------|r")
    print("This addon is a companion for the " .. PREFIX .. " desktop recorder.")
    print("It does |cffff4444two|r small things:")
    print("  |cffffff00 1.|r Saves your character GUID, name, class and spec to")
    print("     SavedVariables so the app knows which party member is |cff00ff00you|r.")
    print("  |cffffff00 2.|r Automatically turns on combat logging in dungeons")
    print("     and when a Mythic+ key starts, so no runs are missed.")
    print("|cffaaaaaa----------------------------------------|r")
    print("|cff00ff00What it does NOT do:|r")
    print("  - Does not read game memory")
    print("  - Does not intercept or modify network packets")
    print("  - Does not change any gameplay behaviour")
    print("  - Only writes data you already see (name, class, spec) to a local file")
    print("|cffaaaaaa----------------------------------------|r")
    print("Type |cffffff00/depleted|r to see this again.")
    print(" ")
end

SLASH_DEPLETED1 = "/depleted"
SlashCmdList["DEPLETED"] = PrintAbout

-- ---------------------------------------------------------------------------
-- Event handling
-- ---------------------------------------------------------------------------

local frame = CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:RegisterEvent("PLAYER_ENTERING_WORLD")
frame:RegisterEvent("ACTIVE_TALENT_GROUP_CHANGED")
frame:RegisterEvent("CHALLENGE_MODE_START")

frame:SetScript("OnEvent", function(_, event)
    -- Print a one-line status on first login so users see the addon is active.
    if event == "PLAYER_LOGIN" then
        print(PREFIX .. " Companion loaded. Type |cffffff00/depleted|r for info.")
    end

    -- Key just started: logging should already be on from entering the dungeon, but
    -- make sure, and tell the player the desktop app should now be recording.
    if event == "CHALLENGE_MODE_START" then
        EnsureCombatLogging()
        print(PREFIX .. " Key started. Depleted should be recording.")
        return
    end

    -- Small delay so UnitGUID / spec APIs return fresh values after zone change.
    C_Timer.After(1, function()
        SaveCharacterInfo()

        -- Entering a dungeon: make sure the combat log is running before the key
        -- starts. This is what lets the desktop app catch the start.
        if event == "PLAYER_ENTERING_WORLD" and IsInRecordableInstance() then
            EnsureCombatLogging()
        end
    end)
end)
