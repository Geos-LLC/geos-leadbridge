/**
 * Static US locations list for the partner-network service-area picker.
 *
 * Used as a <datalist> autocomplete suggestion — the input remains free
 * text, so admins can type "Cape Cod" or "Greater Boston" if they want;
 * this is purely UX assistance + typo prevention for the common case.
 *
 * Lives inside the partner-network folder so the whole module can be
 * extracted later without dragging a shared LeadBridge asset along.
 *
 * Format: each entry is the human-readable string we want the admin to
 * pick / type, e.g. "Boston, MA" or just "Massachusetts" for a whole-state
 * service area. Sorted alphabetically per group; states block first so
 * statewide picks surface above city specifics with the same prefix.
 */

const US_STATES_AND_DC: string[] = [
  'Alabama',
  'Alaska',
  'Arizona',
  'Arkansas',
  'California',
  'Colorado',
  'Connecticut',
  'Delaware',
  'District of Columbia',
  'Florida',
  'Georgia',
  'Hawaii',
  'Idaho',
  'Illinois',
  'Indiana',
  'Iowa',
  'Kansas',
  'Kentucky',
  'Louisiana',
  'Maine',
  'Maryland',
  'Massachusetts',
  'Michigan',
  'Minnesota',
  'Mississippi',
  'Missouri',
  'Montana',
  'Nebraska',
  'Nevada',
  'New Hampshire',
  'New Jersey',
  'New Mexico',
  'New York',
  'North Carolina',
  'North Dakota',
  'Ohio',
  'Oklahoma',
  'Oregon',
  'Pennsylvania',
  'Rhode Island',
  'South Carolina',
  'South Dakota',
  'Tennessee',
  'Texas',
  'Utah',
  'Vermont',
  'Virginia',
  'Washington',
  'West Virginia',
  'Wisconsin',
  'Wyoming',
];

// ~300 of the largest US cities + most state capitals. Curated by
// population rank; not exhaustive. Free-text entry remains supported via
// the datalist behavior so an admin in a smaller market can type their
// own city.
const US_CITIES: string[] = [
  'Akron, OH', 'Albany, NY', 'Albuquerque, NM', 'Alexandria, VA', 'Allentown, PA',
  'Amarillo, TX', 'Anaheim, CA', 'Anchorage, AK', 'Ann Arbor, MI', 'Annapolis, MD',
  'Antioch, CA', 'Arlington, TX', 'Arlington, VA', 'Arvada, CO', 'Athens, GA',
  'Atlanta, GA', 'Augusta, GA', 'Augusta, ME', 'Aurora, CO', 'Aurora, IL',
  'Austin, TX', 'Bakersfield, CA', 'Baltimore, MD', 'Baton Rouge, LA', 'Beaumont, TX',
  'Bellevue, WA', 'Berkeley, CA', 'Billings, MT', 'Birmingham, AL', 'Bismarck, ND',
  'Boise, ID', 'Boston, MA', 'Boulder, CO', 'Bridgeport, CT', 'Brockton, MA',
  'Brooklyn, NY', 'Brownsville, TX', 'Buffalo, NY', 'Burlington, VT', 'Cambridge, MA',
  'Cape Coral, FL', 'Carlsbad, CA', 'Carrollton, TX', 'Carson, CA', 'Cary, NC',
  'Cedar Rapids, IA', 'Centennial, CO', 'Chandler, AZ', 'Charleston, SC', 'Charleston, WV',
  'Charlotte, NC', 'Charlottesville, VA', 'Chattanooga, TN', 'Chesapeake, VA', 'Cheyenne, WY',
  'Chicago, IL', 'Chula Vista, CA', 'Cincinnati, OH', 'Clarksville, TN', 'Clearwater, FL',
  'Cleveland, OH', 'Clovis, CA', 'College Station, TX', 'Colorado Springs, CO', 'Columbia, MO',
  'Columbia, SC', 'Columbus, GA', 'Columbus, OH', 'Concord, CA', 'Concord, NH',
  'Coral Springs, FL', 'Corona, CA', 'Corpus Christi, TX', 'Costa Mesa, CA', 'Dallas, TX',
  'Daly City, CA', 'Davenport, IA', 'Dayton, OH', 'Denton, TX', 'Denver, CO',
  'Des Moines, IA', 'Detroit, MI', 'Dover, DE', 'Downey, CA', 'Durham, NC',
  'El Cajon, CA', 'El Monte, CA', 'El Paso, TX', 'Elgin, IL', 'Elizabeth, NJ',
  'Elk Grove, CA', 'Erie, PA', 'Escondido, CA', 'Eugene, OR', 'Evansville, IN',
  'Everett, WA', 'Fairfield, CA', 'Fargo, ND', 'Fayetteville, AR', 'Fayetteville, NC',
  'Fontana, CA', 'Fort Collins, CO', 'Fort Lauderdale, FL', 'Fort Wayne, IN', 'Fort Worth, TX',
  'Frankfort, KY', 'Fremont, CA', 'Fresno, CA', 'Frisco, TX', 'Fullerton, CA',
  'Gainesville, FL', 'Garden Grove, CA', 'Garland, TX', 'Gilbert, AZ', 'Glendale, AZ',
  'Glendale, CA', 'Grand Prairie, TX', 'Grand Rapids, MI', 'Greeley, CO', 'Green Bay, WI',
  'Greensboro, NC', 'Gresham, OR', 'Hampton, VA', 'Harrisburg, PA', 'Hartford, CT',
  'Hayward, CA', 'Helena, MT', 'Henderson, NV', 'Hialeah, FL', 'High Point, NC',
  'Hillsboro, OR', 'Hollywood, FL', 'Honolulu, HI', 'Houston, TX', 'Huntington Beach, CA',
  'Huntsville, AL', 'Independence, MO', 'Indianapolis, IN', 'Inglewood, CA', 'Irvine, CA',
  'Irving, TX', 'Jackson, MS', 'Jacksonville, FL', 'Jefferson City, MO', 'Jersey City, NJ',
  'Joliet, IL', 'Juneau, AK', 'Kansas City, KS', 'Kansas City, MO', 'Kent, WA',
  'Killeen, TX', 'Knoxville, TN', 'Lafayette, LA', 'Lakewood, CA', 'Lakewood, CO',
  'Lancaster, CA', 'Lansing, MI', 'Laredo, TX', 'Las Cruces, NM', 'Las Vegas, NV',
  'Lawton, OK', 'Lexington, KY', 'Lincoln, NE', 'Little Rock, AR', 'Long Beach, CA',
  'Los Angeles, CA', 'Louisville, KY', 'Lowell, MA', 'Lubbock, TX', 'Macon, GA',
  'Madison, WI', 'Manchester, NH', 'McAllen, TX', 'McKinney, TX', 'Memphis, TN',
  'Mesa, AZ', 'Mesquite, TX', 'Miami, FL', 'Miami Gardens, FL', 'Midland, TX',
  'Milwaukee, WI', 'Minneapolis, MN', 'Miramar, FL', 'Mobile, AL', 'Modesto, CA',
  'Montgomery, AL', 'Montpelier, VT', 'Moreno Valley, CA', 'Murfreesboro, TN', 'Murrieta, CA',
  'Naperville, IL', 'Nashville, TN', 'New Haven, CT', 'New Orleans, LA', 'New York, NY',
  'Newark, NJ', 'Newport News, VA', 'Norfolk, VA', 'Norman, OK', 'North Charleston, SC',
  'North Las Vegas, NV', 'Oakland, CA', 'Oceanside, CA', 'Odessa, TX', 'Oklahoma City, OK',
  'Olathe, KS', 'Olympia, WA', 'Omaha, NE', 'Ontario, CA', 'Orange, CA',
  'Orlando, FL', 'Overland Park, KS', 'Oxnard, CA', 'Palm Bay, FL', 'Palmdale, CA',
  'Pasadena, CA', 'Pasadena, TX', 'Paterson, NJ', 'Pearland, TX', 'Pembroke Pines, FL',
  'Peoria, AZ', 'Peoria, IL', 'Philadelphia, PA', 'Phoenix, AZ', 'Pierre, SD',
  'Pittsburgh, PA', 'Plano, TX', 'Pomona, CA', 'Pompano Beach, FL', 'Port St. Lucie, FL',
  'Portland, ME', 'Portland, OR', 'Providence, RI', 'Provo, UT', 'Pueblo, CO',
  'Queens, NY', 'Raleigh, NC', 'Rancho Cucamonga, CA', 'Reno, NV', 'Renton, WA',
  'Richmond, CA', 'Richmond, VA', 'Riverside, CA', 'Roanoke, VA', 'Rochester, MN',
  'Rochester, NY', 'Rockford, IL', 'Roseville, CA', 'Round Rock, TX', 'Sacramento, CA',
  'Saint Paul, MN', 'Salem, OR', 'Salinas, CA', 'Salt Lake City, UT', 'San Antonio, TX',
  'San Bernardino, CA', 'San Diego, CA', 'San Francisco, CA', 'San Jose, CA', 'San Mateo, CA',
  'Sandy Springs, GA', 'Santa Ana, CA', 'Santa Clara, CA', 'Santa Clarita, CA', 'Santa Fe, NM',
  'Santa Maria, CA', 'Santa Monica, CA', 'Santa Rosa, CA', 'Savannah, GA', 'Scottsdale, AZ',
  'Seattle, WA', 'Shreveport, LA', 'Simi Valley, CA', 'Sioux Falls, SD', 'South Bend, IN',
  'Spokane, WA', 'Springfield, IL', 'Springfield, MA', 'Springfield, MO', 'St. Louis, MO',
  'St. Paul, MN', 'St. Petersburg, FL', 'Stamford, CT', 'Sterling Heights, MI', 'Stockton, CA',
  'Sunnyvale, CA', 'Surprise, AZ', 'Syracuse, NY', 'Tacoma, WA', 'Tallahassee, FL',
  'Tampa, FL', 'Temecula, CA', 'Tempe, AZ', 'Thornton, CO', 'Thousand Oaks, CA',
  'Toledo, OH', 'Topeka, KS', 'Torrance, CA', 'Trenton, NJ', 'Tucson, AZ',
  'Tulsa, OK', 'Tyler, TX', 'Vallejo, CA', 'Vancouver, WA', 'Ventura, CA',
  'Victorville, CA', 'Virginia Beach, VA', 'Visalia, CA', 'Waco, TX', 'Warren, MI',
  'Washington, DC', 'Waterbury, CT', 'West Covina, CA', 'West Valley City, UT', 'Westminster, CO',
  'Wichita, KS', 'Wichita Falls, TX', 'Wilmington, DE', 'Wilmington, NC', 'Winston-Salem, NC',
  'Worcester, MA', 'Yonkers, NY',
];

// Combined list — states first so a typist hitting "M" sees "Massachusetts"
// at the top before the cities, then alphabetical city list.
export const US_LOCATION_SUGGESTIONS: string[] = [
  ...US_STATES_AND_DC,
  ...US_CITIES,
];

// Loose validator for the "looks like City, ST" hint. Returns true for any
// known suggestion AND for free-text strings that already match the
// "City, ST" or "Statewide" shape — so light input feedback can fire
// without rejecting unknown small towns.
const CITY_STATE_RE = /^[A-Za-z .'\-]+,\s*[A-Z]{2}$/;
const STATE_NAMES = new Set(US_STATES_AND_DC.map(s => s.toLowerCase()));

export function looksLikeServiceArea(input: string): boolean {
  const v = input.trim();
  if (!v) return true; // empty is OK — field is optional
  if (CITY_STATE_RE.test(v)) return true;
  if (STATE_NAMES.has(v.toLowerCase())) return true;
  return false;
}
