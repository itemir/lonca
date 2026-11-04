const CITIES = `
abuja accra adelaide agadir almaty amman amsterdam ankara antalya antwerp asmara astana athens
auckland baku bali bamako bangkok barcelona basel beirut belgrade bergen berlin bern bilbao bogota
bologna bordeaux boston bratislava bremen brisbane bruges brussels bucharest budapest bursa cairo
calgary cape-town caracas cardiff casablanca chicago cologne colombo copenhagen cordoba cork
dakar damascus delhi denver dhaka doha dublin dubrovnik durban edinburgh erzurum fez florence
frankfurt galway gdansk geneva genoa ghent glasgow granada graz hanoi havana helsinki hobart
istanbul izmir jaipur jakarta kabul kampala karachi kathmandu kigali kolkata krakow kyoto lagos
lahore lhasa lima lisbon ljubljana lyon madrid malaga malmo manila maputo marrakesh marseille
medellin melbourne milan minsk montreal moscow mumbai munich muscat nairobi nantes naples nicosia
odessa osaka oslo ottawa oxford palermo paris perth porto prague quito reykjavik riga rome salzburg
santiago sarajevo seoul seville shiraz sofia split stockholm sydney tallinn tangier tashkent tbilisi
tehran tirana tokyo toledo toronto trabzon tunis turin utrecht valencia valletta venice vienna
vilnius warsaw wellington yerevan zagreb zurich
`.trim().split(/\s+/);

/** Picks a random city that isn't taken, adding a number once they all are. */
export function pickWorkspaceName(taken: Set<string>): string {
  const free = CITIES.filter((city) => !taken.has(city));
  if (free.length > 0) return free[Math.floor(Math.random() * free.length)];
  for (let n = 2; ; n++) {
    const name = `${CITIES[Math.floor(Math.random() * CITIES.length)]}-${n}`;
    if (!taken.has(name)) return name;
  }
}
