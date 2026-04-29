const assert = require("node:assert/strict");
const Converter = require("../converter");

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    throw error;
  }
}

test("extracts @lat,lng from Google Maps place URL", () => {
  const result = Converter.analyzeInput("https://www.google.com/maps/place/Tokyo+Station/@35.6812362,139.7671248,17z");
  assert.equal(result.kind, "google-url");
  assert.deepEqual(result.coords, { lat: 35.6812362, lng: 139.7671248, source: "@lat,lng" });
  assert.equal(result.keyword, "Tokyo Station");
});

test("extracts !3d!4d coordinates from Google Maps data URL", () => {
  const result = Converter.analyzeInput("https://www.google.com/maps/place/foo/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d35.658584!4d139.745431");
  assert.equal(result.coords.lat, 35.658584);
  assert.equal(result.coords.lng, 139.745431);
});

test("parses plain longitude latitude when first value is too large for latitude", () => {
  const result = Converter.analyzeInput("139.767125,35.681236");
  assert.equal(result.kind, "coordinates");
  assert.deepEqual(result.coords, { lat: 35.681236, lng: 139.767125 });
});

test("identifies Japanese prefecture", () => {
  const result = Converter.analyzeInput("東京都千代田区丸の内1丁目9-1");
  assert.equal(result.kind, "address");
  assert.equal(result.prefecture, "東京都");
  assert.equal(Converter.isLikelyDetailedJapaneseAddress(result.rawInput), true);
});

test("does not treat a bare place name as a detailed Japanese address", () => {
  assert.equal(Converter.isLikelyDetailedJapaneseAddress("渋谷駅"), false);
  assert.equal(Converter.isLikelyDetailedJapaneseAddress("Shibuya Station, Tokyo"), false);
});

test("warns when building or floor details are not confirmed by geocoder result", () => {
  const input = "〒121-0061 東京都足立区花畑５丁目１２−１２ 81号棟 1階";
  const resolved = "東京都足立区花畑五丁目１２番１２号";
  assert.deepEqual(Converter.extractSubAddressTokens(input), ["81号棟", "1階"]);
  assert.match(Converter.buildSubAddressPrecisionNotice(input, resolved), /81号棟、1階/);
});

test("builds AMap marker URL with WGS84 coordinates", () => {
  const links = Converter.buildAmapLinks({
    coords: { lat: 35.6812362, lng: 139.7671248 },
    name: "東京駅",
    keyword: "東京駅",
    city: "東京都"
  });
  assert.match(links.marker, /^https:\/\/uri\.amap\.com\/marker\?/);
  assert.match(links.marker, /position=139\.7671248,35\.6812362/);
  assert.match(links.marker, /coordinate=wgs84/);
  assert.match(links.marker, /callnative=1/);
  assert.match(links.appMarkerIos, /^iosamap:\/\/viewMap\?/);
  assert.match(links.appMarkerIos, /lat=35\.6812362/);
  assert.match(links.appMarkerAndroid, /^androidamap:\/\/viewMap\?/);
  assert.match(links.appMarkerAndroid, /lon=139\.7671248/);
  assert.match(links.appMarkerAndroid, /dev=1/);
  assert.equal(links.navigation, undefined);
  assert.equal(links.appNavigationAndroid, undefined);
});

test("does not leak Google URLs into AMap destination names", () => {
  const links = Converter.buildAmapLinks({
    coords: { lat: 35.6812362, lng: 139.7671248 },
    name: "https://maps.app.goo.gl/example",
    keyword: "https://maps.app.goo.gl/example"
  });
  assert.doesNotMatch(decodeURIComponent(links.marker), /google|goo\.gl|maps\.app/i);
  assert.match(decodeURIComponent(links.marker), /目的地/);
  assert.doesNotMatch(decodeURIComponent(links.appMarkerAndroid), /google|goo\.gl|maps\.app/i);
  assert.match(decodeURIComponent(links.appMarkerAndroid), /poiname=目的地/);
});

test("does not use the original short URL as a Google coordinate label", () => {
  const result = Converter.analyzeInput("https://www.google.com/maps/@35.6812362,139.7671248,17z\nhttps://maps.app.goo.gl/example");
  assert.equal(result.kind, "google-url");
  assert.deepEqual(result.coords, { lat: 35.6812362, lng: 139.7671248, source: "@lat,lng" });
  assert.equal(result.keyword, "");
});

test("normalizes Nominatim result", () => {
  const item = {
    place_id: 1,
    lat: "35.681236",
    lon: "139.767125",
    display_name: "東京駅, 東京都, 日本",
    class: "railway",
    type: "station"
  };
  const result = Converter.normalizeNominatimResult(item);
  assert.equal(result.displayName, "東京駅, 東京都, 日本");
  assert.deepEqual(result.coords, { lat: 35.681236, lng: 139.767125 });
});

test("normalizes GSI address-search result", () => {
  const item = {
    geometry: { coordinates: [139.767242, 35.681252], type: "Point" },
    properties: { title: "東京都千代田区丸の内一丁目９番" }
  };
  const result = Converter.normalizeGsiResult(item, 0);
  assert.equal(result.displayName, "東京都千代田区丸の内一丁目９番");
  assert.equal(result.provider, "gsi");
  assert.deepEqual(result.coords, { lat: 35.681252, lng: 139.767242 });
});
