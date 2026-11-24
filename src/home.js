'use strict';

// Home's shelves: eighty games the owner chose, in six groups, in the owner's order. They are a list
// rather than a feed, so Home costs no store request and never changes under a person between visits.
// Trap: an id here must be the game's own app id on the store (not a DLC, a demo or an old edition);
// the names are the owner's, so a card reads the same as the list it came from.

const SHELVES = [
  ['AAA / Open World', [
    [3240220, 'Grand Theft Auto V'], [1174180, 'Red Dead Redemption 2'], [1091500, 'Cyberpunk 2077'],
    [292030, 'The Witcher 3: Wild Hunt'], [1771300, 'Kingdom Come: Deliverance II'], [990080, 'Hogwarts Legacy'],
    [1259420, 'Days Gone'], [2215430, "Ghost of Tsushima Director's Cut"], [2561580, 'Horizon Zero Dawn Remastered'],
    [1817070, "Marvel's Spider-Man Remastered"], [1817190, "Marvel's Spider-Man: Miles Morales"], [1593500, 'God of War'],
    [2322010, 'God of War Ragnarök'], [1659420, 'Uncharted: Legacy of Thieves Collection'], [1888930, 'The Last of Us Part I'],
  ]],
  ['Action / Adventure / RPG', [
    [1245620, 'Elden Ring'], [1086940, "Baldur's Gate 3"], [2358720, 'Black Myth: Wukong'],
    [814380, 'Sekiro: Shadows Die Twice'], [1627720, 'Lies of P'], [374320, 'Dark Souls III'],
    [582010, 'Monster Hunter: World'], [2054970, "Dragon's Dogma 2"], [1145360, 'Hades'],
    [1145350, 'Hades II'], [367520, 'Hollow Knight'], [1030300, 'Hollow Knight: Silksong'],
    [588650, 'Dead Cells'], [1057090, 'Ori and the Will of the Wisps'], [268910, 'Cuphead'],
  ]],
  ['Survival / Building / Simulation', [
    [264710, 'Subnautica'], [848450, 'Subnautica: Below Zero'], [108600, 'Project Zomboid'],
    [294100, 'RimWorld'], [427520, 'Factorio'], [526870, 'Satisfactory'],
    [413150, 'Stardew Valley'], [105600, 'Terraria'], [892970, 'Valheim'],
    [242760, 'The Forest'], [1326470, 'Sons Of The Forest'], [251570, '7 Days to Die'],
    [227300, 'Euro Truck Simulator 2'], [270880, 'American Truck Simulator'], [255710, 'Cities: Skylines'],
  ]],
  ['Horror / Story', [
    [883710, 'Resident Evil 2'], [952060, 'Resident Evil 3'], [2050650, 'Resident Evil 4'],
    [418370, 'Resident Evil 7 Biohazard'], [1196590, 'Resident Evil Village'], [1693980, 'Dead Space'],
    [214490, 'Alien: Isolation'], [238320, 'Outlast'], [414700, 'Outlast 2'],
    [1944430, 'Amnesia: The Bunker'],
  ]],
  ['FPS / Action', [
    [782330, 'DOOM Eternal'], [379720, 'DOOM (2016)'], [1237970, 'Titanfall 2'],
    [412020, 'Metro Exodus'], [287390, 'Metro Last Light Redux'], [201810, 'Wolfenstein: The New Order'],
    [612880, 'Wolfenstein II: The New Colossus'], [552520, 'Far Cry 5'], [2369390, 'Far Cry 6'],
    [239140, 'Dying Light'],
  ]],
  ['Strategy / Indie / Other', [
    [289070, 'Civilization VI'], [394360, 'Hearts of Iron IV'], [1158310, 'Crusader Kings III'],
    [261550, 'Mount & Blade II: Bannerlord'], [1142710, 'Total War: WARHAMMER III'], [250900, 'The Binding of Isaac: Rebirth'],
    [646570, 'Slay the Spire'], [1794680, 'Vampire Survivors'], [1229490, 'ULTRAKILL'],
    [322170, 'Geometry Dash'], [620, 'Portal 2'], [400, 'Portal'],
    [304430, 'INSIDE'], [1332010, 'Stray'], [1868140, 'Dave the Diver'],
  ]],
].map(([title, games]) => ({ title, games: games.map(([appid, name]) => ({ appid: String(appid), name })) }));

module.exports = { SHELVES };
