import type {
  SurfaceStop,
  SurfaceRoute,
  RouteShape,
  RouteStopAssociation,
  ArrivalPrediction,
  LiveVehiclePosition,
} from "~/domain/surface/types";

/**
 * Development and test mock surface routes fixture.
 */
export const MOCK_SURFACE_ROUTES: readonly SurfaceRoute[] = [
  {
    id: "501",
    shortName: "501",
    longName: "Queen",
    routeType: "streetcar",
    color: "#DA251D",
    textColor: "#FFFFFF",
  },
  {
    id: "504",
    shortName: "504",
    longName: "King",
    routeType: "streetcar",
    color: "#DA251D",
    textColor: "#FFFFFF",
  },
  {
    id: "506",
    shortName: "506",
    longName: "Carlton",
    routeType: "streetcar",
    color: "#DA251D",
    textColor: "#FFFFFF",
  },
  {
    id: "510",
    shortName: "510",
    longName: "Spadina",
    routeType: "streetcar",
    color: "#DA251D",
    textColor: "#FFFFFF",
  },
  {
    id: "97",
    shortName: "97",
    longName: "Yonge",
    routeType: "bus",
    color: "#DA251D",
    textColor: "#FFFFFF",
  },
  {
    id: "91",
    shortName: "91",
    longName: "Woodbine",
    routeType: "bus",
    color: "#DA251D",
    textColor: "#FFFFFF",
  },
  {
    id: "900",
    shortName: "900",
    longName: "Airport Express",
    routeType: "express",
    color: "#00853F",
    textColor: "#FFFFFF",
  },
];

/**
 * Development and test mock surface stops fixture with full corridor stations.
 */
export const MOCK_SURFACE_STOPS: readonly SurfaceStop[] = [
  // 97 Yonge Corridor
  {
    id: "14574",
    code: "1236",
    name: "Queens Quay at Yonge St",
    lat: 43.6425,
    lon: -79.375,
    wheelchair: 1,
    routes: ["97"],
  },
  {
    id: "14575",
    code: "1237",
    name: "Yonge St at King St",
    lat: 43.6485,
    lon: -79.3775,
    wheelchair: 1,
    parentStation: "king",
    parentStationId: "king",
    routes: ["97"],
  },
  {
    id: "14573",
    code: "1235",
    name: "Yonge St at Queen St",
    lat: 43.6525,
    lon: -79.379,
    wheelchair: 1,
    parentStation: "queen",
    parentStationId: "queen",
    routes: ["97"],
  },
  {
    id: "14576",
    code: "1238",
    name: "Yonge St at College St",
    lat: 43.661,
    lon: -79.383,
    wheelchair: 1,
    parentStation: "college",
    parentStationId: "college",
    routes: ["97"],
  },
  {
    id: "14560",
    code: "1234",
    name: "Yonge St at Bloor St East",
    lat: 43.6715,
    lon: -79.3862,
    wheelchair: 1,
    parentStation: "bloor-yonge",
    parentStationId: "bloor-yonge",
    routes: ["97"],
  },
  {
    id: "14577",
    code: "1239",
    name: "Yonge St at St Clair Ave",
    lat: 43.688,
    lon: -79.393,
    wheelchair: 1,
    parentStation: "st-clair",
    parentStationId: "st-clair",
    routes: ["97"],
  },
  {
    id: "14572",
    code: "1232",
    name: "Yonge St at Eglinton Ave",
    lat: 43.7065,
    lon: -79.398,
    wheelchair: 1,
    parentStation: "eglinton",
    parentStationId: "eglinton",
    routes: ["97"],
  },
  {
    id: "14571",
    code: "1231",
    name: "Yonge St at Lawrence Ave",
    lat: 43.7255,
    lon: -79.402,
    wheelchair: 1,
    parentStation: "lawrence",
    parentStationId: "lawrence",
    routes: ["97"],
  },
  {
    id: "14578",
    code: "1240",
    name: "Yonge St at York Mills Rd",
    lat: 43.744,
    lon: -79.406,
    wheelchair: 1,
    parentStation: "york-mills",
    parentStationId: "york-mills",
    routes: ["97"],
  },
  {
    id: "14579",
    code: "1241",
    name: "Yonge St at Finch Ave",
    lat: 43.78,
    lon: -79.415,
    wheelchair: 1,
    parentStation: "finch",
    parentStationId: "finch",
    routes: ["97"],
  },
  {
    id: "14570",
    code: "1230",
    name: "Yonge St at Steeles Ave",
    lat: 43.7915,
    lon: -79.418,
    wheelchair: 1,
    routes: ["97"],
  },

  // 506 Carlton Corridor
  {
    id: "14580",
    code: "5670",
    name: "High Park Loop",
    lat: 43.654,
    lon: -79.467,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14585",
    code: "5675",
    name: "Howard Park Ave at Roncesvalles Ave",
    lat: 43.655,
    lon: -79.449,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14586",
    code: "5676",
    name: "College St at Dundas St West",
    lat: 43.6555,
    lon: -79.435,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14587",
    code: "5677",
    name: "College St at Lansdowne Ave",
    lat: 43.6558,
    lon: -79.428,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14588",
    code: "5678",
    name: "College St at Ossington Ave",
    lat: 43.656,
    lon: -79.42,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14581",
    code: "5671",
    name: "College St at Bathurst St",
    lat: 43.6565,
    lon: -79.4075,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14589",
    code: "5679",
    name: "College St at Spadina Ave",
    lat: 43.658,
    lon: -79.399,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14582",
    code: "5672",
    name: "College St at University Ave",
    lat: 43.6595,
    lon: -79.39,
    wheelchair: 1,
    parentStation: "queens-park",
    parentStationId: "queens-park",
    routes: ["506"],
  },
  {
    id: "14561",
    code: "5678",
    name: "Carlton St at Church St",
    lat: 43.6625,
    lon: -79.3785,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14594",
    code: "5680",
    name: "Carlton St at Parliament St",
    lat: 43.664,
    lon: -79.368,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14583",
    code: "5673",
    name: "Gerrard St East at Broadview Ave",
    lat: 43.6655,
    lon: -79.3525,
    wheelchair: 1,
    routes: ["506"],
  },
  {
    id: "14584",
    code: "5674",
    name: "Main Street Station Loop",
    lat: 43.689,
    lon: -79.3015,
    wheelchair: 1,
    parentStation: "main-street",
    parentStationId: "main-street",
    routes: ["506"],
  },

  // 501 Queen Corridor
  {
    id: "14590",
    code: "4410",
    name: "Humber Loop",
    lat: 43.6335,
    lon: -79.489,
    wheelchair: 1,
    routes: ["501"],
  },
  {
    id: "14591",
    code: "4411",
    name: "Queen St West at Roncesvalles Ave",
    lat: 43.6395,
    lon: -79.4465,
    wheelchair: 1,
    routes: ["501"],
  },
  {
    id: "14601",
    code: "4414",
    name: "Queen St West at Dufferin St",
    lat: 43.6425,
    lon: -79.428,
    wheelchair: 1,
    routes: ["501"],
  },
  {
    id: "14602",
    code: "4415",
    name: "Queen St West at Ossington Ave",
    lat: 43.6445,
    lon: -79.418,
    wheelchair: 1,
    routes: ["501"],
  },
  {
    id: "14603",
    code: "4416",
    name: "Queen St West at Bathurst St",
    lat: 43.647,
    lon: -79.404,
    wheelchair: 1,
    routes: ["501"],
  },
  {
    id: "14563",
    code: "4401",
    name: "Queen St West at Spadina Ave",
    lat: 43.6492,
    lon: -79.3975,
    wheelchair: 1,
    routes: ["501", "510"],
  },
  {
    id: "14604",
    code: "4417",
    name: "Queen St West at University Ave",
    lat: 43.6508,
    lon: -79.387,
    wheelchair: 1,
    parentStation: "osgoode",
    parentStationId: "osgoode",
    routes: ["501"],
  },
  {
    id: "14592",
    code: "4412",
    name: "Queen St West at Yonge St",
    lat: 43.6522,
    lon: -79.3792,
    wheelchair: 1,
    parentStation: "queen",
    parentStationId: "queen",
    routes: ["501"],
  },
  {
    id: "14605",
    code: "4418",
    name: "Queen St East at Parliament St",
    lat: 43.655,
    lon: -79.362,
    wheelchair: 1,
    routes: ["501"],
  },
  {
    id: "14606",
    code: "4419",
    name: "Queen St East at Broadview Ave",
    lat: 43.658,
    lon: -79.349,
    wheelchair: 1,
    routes: ["501"],
  },
  {
    id: "14593",
    code: "4413",
    name: "Neville Park Loop",
    lat: 43.673,
    lon: -79.2885,
    wheelchair: 1,
    routes: ["501"],
  },

  // 504 King Corridor
  {
    id: "14595",
    code: "4420",
    name: "Dundas West Station Loop",
    lat: 43.6568,
    lon: -79.453,
    wheelchair: 1,
    parentStation: "dundas-west",
    parentStationId: "dundas-west",
    routes: ["504"],
  },
  {
    id: "14610",
    code: "4422",
    name: "Roncesvalles Ave at Queen St West",
    lat: 43.6395,
    lon: -79.4465,
    wheelchair: 1,
    routes: ["504"],
  },
  {
    id: "14611",
    code: "4423",
    name: "King St West at Dufferin St",
    lat: 43.6405,
    lon: -79.426,
    wheelchair: 1,
    routes: ["504"],
  },
  {
    id: "14612",
    code: "4424",
    name: "King St West at Bathurst St",
    lat: 43.644,
    lon: -79.403,
    wheelchair: 1,
    routes: ["504"],
  },
  {
    id: "14613",
    code: "4425",
    name: "King St West at Spadina Ave",
    lat: 43.6455,
    lon: -79.395,
    wheelchair: 1,
    routes: ["504"],
  },
  {
    id: "14614",
    code: "4426",
    name: "King St West at University Ave",
    lat: 43.6475,
    lon: -79.385,
    wheelchair: 1,
    parentStation: "st-andrew",
    parentStationId: "st-andrew",
    routes: ["504"],
  },
  {
    id: "14564",
    code: "4402",
    name: "King St West at Bay St",
    lat: 43.6483,
    lon: -79.3802,
    wheelchair: 1,
    routes: ["504"],
  },
  {
    id: "14615",
    code: "4427",
    name: "King St East at Yonge St",
    lat: 43.6492,
    lon: -79.3775,
    wheelchair: 1,
    parentStation: "king",
    parentStationId: "king",
    routes: ["504"],
  },
  {
    id: "14616",
    code: "4428",
    name: "King St East at Parliament St",
    lat: 43.652,
    lon: -79.361,
    wheelchair: 1,
    routes: ["504"],
  },
  {
    id: "14596",
    code: "4421",
    name: "Broadview Station Loop",
    lat: 43.6765,
    lon: -79.3582,
    wheelchair: 1,
    parentStation: "broadview",
    parentStationId: "broadview",
    routes: ["504"],
  },

  // 510 Spadina Corridor
  {
    id: "14597",
    code: "4430",
    name: "Spadina Station Loop",
    lat: 43.6672,
    lon: -79.4042,
    wheelchair: 1,
    parentStation: "spadina",
    parentStationId: "spadina",
    routes: ["510"],
  },
  {
    id: "14620",
    code: "4432",
    name: "Spadina Ave at Harbord St",
    lat: 43.6625,
    lon: -79.402,
    wheelchair: 1,
    routes: ["510"],
  },
  {
    id: "14621",
    code: "4433",
    name: "Spadina Ave at College St",
    lat: 43.658,
    lon: -79.399,
    wheelchair: 1,
    routes: ["510"],
  },
  {
    id: "14622",
    code: "4434",
    name: "Spadina Ave at Dundas St West",
    lat: 43.6535,
    lon: -79.398,
    wheelchair: 1,
    routes: ["510"],
  },
  {
    id: "14566",
    code: "4404",
    name: "Spadina Ave at Richmond St",
    lat: 43.6488,
    lon: -79.397,
    wheelchair: 1,
    routes: ["510"],
  },
  {
    id: "14623",
    code: "4435",
    name: "Spadina Ave at King St West",
    lat: 43.6455,
    lon: -79.395,
    wheelchair: 1,
    routes: ["510"],
  },
  {
    id: "14624",
    code: "4436",
    name: "Spadina Ave at Bremner Blvd",
    lat: 43.6415,
    lon: -79.3935,
    wheelchair: 1,
    routes: ["510"],
  },
  {
    id: "14598",
    code: "4431",
    name: "Queens Quay at Spadina Ave",
    lat: 43.6385,
    lon: -79.393,
    wheelchair: 1,
    routes: ["510"],
  },

  // 91 Woodbine Corridor
  {
    id: "14565",
    code: "4403",
    name: "Woodbine Ave at Strathmore Blvd",
    lat: 43.6872,
    lon: -79.3135,
    wheelchair: 1,
    routes: ["91"],
  },
  {
    id: "14634",
    code: "9995",
    name: "Woodbine Ave at O'Connor Dr",
    lat: 43.7,
    lon: -79.3185,
    wheelchair: 1,
    routes: ["91"],
  },
];

/**
 * Development and test mock route shapes fixture for both directions (0 and 1).
 */
export const MOCK_ROUTE_SHAPES: readonly RouteShape[] = [
  // 501 Queen
  {
    id: "501_0_canonical",
    routeId: "501",
    directionId: 0,
    headsign: "West — 501 Queen to Humber Loop",
    polyline: "u{~vGfa`bO_@k@...",
    minLat: 43.633,
    maxLat: 43.675,
    minLon: -79.495,
    maxLon: -79.285,
    pointCount: 312,
  },
  {
    id: "501_1_canonical",
    routeId: "501",
    directionId: 1,
    headsign: "East — 501 Queen to Neville Park Loop",
    polyline: "u{~vGfa`bO_@k@...",
    minLat: 43.633,
    maxLat: 43.675,
    minLon: -79.495,
    maxLon: -79.285,
    pointCount: 312,
  },

  // 504 King
  {
    id: "504_0_canonical",
    routeId: "504",
    directionId: 0,
    headsign: "West — 504 King to Dundas West Station",
    polyline: "a|~vGza`bO_@k@...",
    minLat: 43.645,
    maxLat: 43.68,
    minLon: -79.455,
    maxLon: -79.355,
    pointCount: 280,
  },
  {
    id: "504_1_canonical",
    routeId: "504",
    directionId: 1,
    headsign: "East — 504 King to Broadview Station",
    polyline: "a|~vGza`bO_@k@...",
    minLat: 43.645,
    maxLat: 43.68,
    minLon: -79.455,
    maxLon: -79.355,
    pointCount: 280,
  },

  // 506 Carlton
  {
    id: "506_0_canonical",
    routeId: "506",
    directionId: 0,
    headsign: "East — 506 Carlton to Main Street Station",
    polyline: "c{~vGfa`bO_@k@...",
    minLat: 43.65,
    maxLat: 43.69,
    minLon: -79.47,
    maxLon: -79.3,
    pointCount: 260,
  },
  {
    id: "506_1_canonical",
    routeId: "506",
    directionId: 1,
    headsign: "West — 506 Carlton to High Park Loop",
    polyline: "c{~vGfa`bO_@k@...",
    minLat: 43.65,
    maxLat: 43.69,
    minLon: -79.47,
    maxLon: -79.3,
    pointCount: 260,
  },

  // 510 Spadina
  {
    id: "510_0_canonical",
    routeId: "510",
    directionId: 0,
    headsign: "South — 510 Spadina to Queens Quay",
    polyline: "g{~vGfa`bO_@k@...",
    minLat: 43.635,
    maxLat: 43.67,
    minLon: -79.405,
    maxLon: -79.39,
    pointCount: 180,
  },
  {
    id: "510_1_canonical",
    routeId: "510",
    directionId: 1,
    headsign: "North — 510 Spadina to Spadina Station",
    polyline: "g{~vGfa`bO_@k@...",
    minLat: 43.635,
    maxLat: 43.67,
    minLon: -79.405,
    maxLon: -79.39,
    pointCount: 180,
  },

  // 97 Yonge
  {
    id: "97_0_canonical",
    routeId: "97",
    directionId: 0,
    headsign: "North — 97 Yonge to Steeles Ave",
    polyline: "e{~vGfa`bO_@k@...",
    minLat: 43.64,
    maxLat: 43.795,
    minLon: -79.42,
    maxLon: -79.37,
    pointCount: 220,
  },
  {
    id: "97_1_canonical",
    routeId: "97",
    directionId: 1,
    headsign: "South — 97 Yonge to Queens Quay",
    polyline: "e{~vGfa`bO_@k@...",
    minLat: 43.64,
    maxLat: 43.795,
    minLon: -79.42,
    maxLon: -79.37,
    pointCount: 220,
  },

  // 91 Woodbine
  {
    id: "91_0_canonical",
    routeId: "91",
    directionId: 0,
    headsign: "North — 91 Woodbine to Heights Loop",
    polyline: "n{~vGfa`bO_@k@...",
    minLat: 43.685,
    maxLat: 43.705,
    minLon: -79.32,
    maxLon: -79.31,
    pointCount: 120,
  },
  {
    id: "91_1_canonical",
    routeId: "91",
    directionId: 1,
    headsign: "South — 91 Woodbine to Woodbine Station",
    polyline: "n{~vGfa`bO_@k@...",
    minLat: 43.685,
    maxLat: 43.705,
    minLon: -79.32,
    maxLon: -79.31,
    pointCount: 120,
  },
];

/**
 * Development and test mock route stop sequence associations across all corridor stations.
 */
export const MOCK_ROUTE_STOPS: readonly RouteStopAssociation[] = [
  // 97 Yonge Northbound (0)
  { routeId: "97", directionId: 0, stopSequence: 1, stopId: "14574" }, // Queens Quay
  { routeId: "97", directionId: 0, stopSequence: 2, stopId: "14575" }, // King
  { routeId: "97", directionId: 0, stopSequence: 3, stopId: "14573" }, // Queen
  { routeId: "97", directionId: 0, stopSequence: 4, stopId: "14576" }, // College
  { routeId: "97", directionId: 0, stopSequence: 5, stopId: "14560" }, // Bloor-Yonge
  { routeId: "97", directionId: 0, stopSequence: 6, stopId: "14577" }, // St Clair
  { routeId: "97", directionId: 0, stopSequence: 7, stopId: "14572" }, // Eglinton
  { routeId: "97", directionId: 0, stopSequence: 8, stopId: "14571" }, // Lawrence
  { routeId: "97", directionId: 0, stopSequence: 9, stopId: "14578" }, // York Mills
  { routeId: "97", directionId: 0, stopSequence: 10, stopId: "14579" }, // Finch
  { routeId: "97", directionId: 0, stopSequence: 11, stopId: "14570" }, // Steeles

  // 97 Yonge Southbound (1)
  { routeId: "97", directionId: 1, stopSequence: 1, stopId: "14570" },
  { routeId: "97", directionId: 1, stopSequence: 2, stopId: "14579" },
  { routeId: "97", directionId: 1, stopSequence: 3, stopId: "14578" },
  { routeId: "97", directionId: 1, stopSequence: 4, stopId: "14571" },
  { routeId: "97", directionId: 1, stopSequence: 5, stopId: "14572" },
  { routeId: "97", directionId: 1, stopSequence: 6, stopId: "14577" },
  { routeId: "97", directionId: 1, stopSequence: 7, stopId: "14560" },
  { routeId: "97", directionId: 1, stopSequence: 8, stopId: "14576" },
  { routeId: "97", directionId: 1, stopSequence: 9, stopId: "14573" },
  { routeId: "97", directionId: 1, stopSequence: 10, stopId: "14575" },
  { routeId: "97", directionId: 1, stopSequence: 11, stopId: "14574" },

  // 506 Carlton Eastbound (0)
  { routeId: "506", directionId: 0, stopSequence: 1, stopId: "14580" }, // High Park
  { routeId: "506", directionId: 0, stopSequence: 2, stopId: "14585" }, // Roncesvalles
  { routeId: "506", directionId: 0, stopSequence: 3, stopId: "14586" }, // Dundas W
  { routeId: "506", directionId: 0, stopSequence: 4, stopId: "14587" }, // Lansdowne
  { routeId: "506", directionId: 0, stopSequence: 5, stopId: "14588" }, // Ossington
  { routeId: "506", directionId: 0, stopSequence: 6, stopId: "14581" }, // Bathurst
  { routeId: "506", directionId: 0, stopSequence: 7, stopId: "14589" }, // Spadina
  { routeId: "506", directionId: 0, stopSequence: 8, stopId: "14582" }, // University
  { routeId: "506", directionId: 0, stopSequence: 9, stopId: "14561" }, // Church
  { routeId: "506", directionId: 0, stopSequence: 10, stopId: "14594" }, // Parliament
  { routeId: "506", directionId: 0, stopSequence: 11, stopId: "14583" }, // Broadview
  { routeId: "506", directionId: 0, stopSequence: 12, stopId: "14584" }, // Main St

  // 506 Carlton Westbound (1)
  { routeId: "506", directionId: 1, stopSequence: 1, stopId: "14584" },
  { routeId: "506", directionId: 1, stopSequence: 2, stopId: "14583" },
  { routeId: "506", directionId: 1, stopSequence: 3, stopId: "14594" },
  { routeId: "506", directionId: 1, stopSequence: 4, stopId: "14561" },
  { routeId: "506", directionId: 1, stopSequence: 5, stopId: "14582" },
  { routeId: "506", directionId: 1, stopSequence: 6, stopId: "14589" },
  { routeId: "506", directionId: 1, stopSequence: 7, stopId: "14581" },
  { routeId: "506", directionId: 1, stopSequence: 8, stopId: "14588" },
  { routeId: "506", directionId: 1, stopSequence: 9, stopId: "14587" },
  { routeId: "506", directionId: 1, stopSequence: 10, stopId: "14586" },
  { routeId: "506", directionId: 1, stopSequence: 11, stopId: "14585" },
  { routeId: "506", directionId: 1, stopSequence: 12, stopId: "14580" },

  // 501 Queen Westbound (0)
  { routeId: "501", directionId: 0, stopSequence: 1, stopId: "14593" }, // Neville Park
  { routeId: "501", directionId: 0, stopSequence: 2, stopId: "14606" }, // Broadview
  { routeId: "501", directionId: 0, stopSequence: 3, stopId: "14605" }, // Parliament
  { routeId: "501", directionId: 0, stopSequence: 4, stopId: "14592" }, // Yonge
  { routeId: "501", directionId: 0, stopSequence: 5, stopId: "14604" }, // University
  { routeId: "501", directionId: 0, stopSequence: 6, stopId: "14563" }, // Spadina
  { routeId: "501", directionId: 0, stopSequence: 7, stopId: "14603" }, // Bathurst
  { routeId: "501", directionId: 0, stopSequence: 8, stopId: "14602" }, // Ossington
  { routeId: "501", directionId: 0, stopSequence: 9, stopId: "14601" }, // Dufferin
  { routeId: "501", directionId: 0, stopSequence: 10, stopId: "14591" }, // Roncesvalles
  { routeId: "501", directionId: 0, stopSequence: 11, stopId: "14590" }, // Humber Loop

  // 501 Queen Eastbound (1)
  { routeId: "501", directionId: 1, stopSequence: 1, stopId: "14590" },
  { routeId: "501", directionId: 1, stopSequence: 2, stopId: "14591" },
  { routeId: "501", directionId: 1, stopSequence: 3, stopId: "14601" },
  { routeId: "501", directionId: 1, stopSequence: 4, stopId: "14602" },
  { routeId: "501", directionId: 1, stopSequence: 5, stopId: "14603" },
  { routeId: "501", directionId: 1, stopSequence: 6, stopId: "14563" },
  { routeId: "501", directionId: 1, stopSequence: 7, stopId: "14604" },
  { routeId: "501", directionId: 1, stopSequence: 8, stopId: "14592" },
  { routeId: "501", directionId: 1, stopSequence: 9, stopId: "14605" },
  { routeId: "501", directionId: 1, stopSequence: 10, stopId: "14606" },
  { routeId: "501", directionId: 1, stopSequence: 11, stopId: "14593" },

  // 504 King Westbound (0)
  { routeId: "504", directionId: 0, stopSequence: 1, stopId: "14596" }, // Broadview Stn
  { routeId: "504", directionId: 0, stopSequence: 2, stopId: "14616" }, // Parliament
  { routeId: "504", directionId: 0, stopSequence: 3, stopId: "14615" }, // Yonge
  { routeId: "504", directionId: 0, stopSequence: 4, stopId: "14564" }, // Bay
  { routeId: "504", directionId: 0, stopSequence: 5, stopId: "14614" }, // University
  { routeId: "504", directionId: 0, stopSequence: 6, stopId: "14613" }, // Spadina
  { routeId: "504", directionId: 0, stopSequence: 7, stopId: "14612" }, // Bathurst
  { routeId: "504", directionId: 0, stopSequence: 8, stopId: "14611" }, // Dufferin
  { routeId: "504", directionId: 0, stopSequence: 9, stopId: "14610" }, // Roncesvalles
  { routeId: "504", directionId: 0, stopSequence: 10, stopId: "14595" }, // Dundas West Stn

  // 504 King Eastbound (1)
  { routeId: "504", directionId: 1, stopSequence: 1, stopId: "14595" },
  { routeId: "504", directionId: 1, stopSequence: 2, stopId: "14610" },
  { routeId: "504", directionId: 1, stopSequence: 3, stopId: "14611" },
  { routeId: "504", directionId: 1, stopSequence: 4, stopId: "14612" },
  { routeId: "504", directionId: 1, stopSequence: 5, stopId: "14613" },
  { routeId: "504", directionId: 1, stopSequence: 6, stopId: "14614" },
  { routeId: "504", directionId: 1, stopSequence: 7, stopId: "14564" },
  { routeId: "504", directionId: 1, stopSequence: 8, stopId: "14615" },
  { routeId: "504", directionId: 1, stopSequence: 9, stopId: "14616" },
  { routeId: "504", directionId: 1, stopSequence: 10, stopId: "14596" },

  // 510 Spadina Southbound (0)
  { routeId: "510", directionId: 0, stopSequence: 1, stopId: "14597" }, // Spadina Stn
  { routeId: "510", directionId: 0, stopSequence: 2, stopId: "14620" }, // Harbord
  { routeId: "510", directionId: 0, stopSequence: 3, stopId: "14621" }, // College
  { routeId: "510", directionId: 0, stopSequence: 4, stopId: "14622" }, // Dundas
  { routeId: "510", directionId: 0, stopSequence: 5, stopId: "14563" }, // Queen
  { routeId: "510", directionId: 0, stopSequence: 6, stopId: "14566" }, // Richmond
  { routeId: "510", directionId: 0, stopSequence: 7, stopId: "14623" }, // King
  { routeId: "510", directionId: 0, stopSequence: 8, stopId: "14624" }, // Bremner
  { routeId: "510", directionId: 0, stopSequence: 9, stopId: "14598" }, // Queens Quay

  // 510 Spadina Northbound (1)
  { routeId: "510", directionId: 1, stopSequence: 1, stopId: "14598" },
  { routeId: "510", directionId: 1, stopSequence: 2, stopId: "14624" },
  { routeId: "510", directionId: 1, stopSequence: 3, stopId: "14623" },
  { routeId: "510", directionId: 1, stopSequence: 4, stopId: "14566" },
  { routeId: "510", directionId: 1, stopSequence: 5, stopId: "14563" },
  { routeId: "510", directionId: 1, stopSequence: 6, stopId: "14622" },
  { routeId: "510", directionId: 1, stopSequence: 7, stopId: "14621" },
  { routeId: "510", directionId: 1, stopSequence: 8, stopId: "14620" },
  { routeId: "510", directionId: 1, stopSequence: 9, stopId: "14597" },

  // 91 Woodbine Northbound (0)
  { routeId: "91", directionId: 0, stopSequence: 1, stopId: "14562" }, // Woodbine Stn
  { routeId: "91", directionId: 0, stopSequence: 2, stopId: "14565" }, // Strathmore
  { routeId: "91", directionId: 0, stopSequence: 3, stopId: "14631" }, // Mortimer
  { routeId: "91", directionId: 0, stopSequence: 4, stopId: "14632" }, // Cosburn
  { routeId: "91", directionId: 0, stopSequence: 5, stopId: "14634" }, // O'Connor
  { routeId: "91", directionId: 0, stopSequence: 6, stopId: "14599" }, // Heights Loop

  // 91 Woodbine Southbound (1)
  { routeId: "91", directionId: 1, stopSequence: 1, stopId: "14599" },
  { routeId: "91", directionId: 1, stopSequence: 2, stopId: "14634" },
  { routeId: "91", directionId: 1, stopSequence: 3, stopId: "14632" },
  { routeId: "91", directionId: 1, stopSequence: 4, stopId: "14631" },
  { routeId: "91", directionId: 1, stopSequence: 5, stopId: "14565" },
  { routeId: "91", directionId: 1, stopSequence: 6, stopId: "14562" },
];

/**
 * Helper generating realistic dynamic arrival predictions for ALL mock development stops.
 */
export function generateMockArrivalPredictions(
  nowMs = Date.now(),
): Map<string, ArrivalPrediction[]> {
  const map = new Map<string, ArrivalPrediction[]>();

  // Ensure every stop in MOCK_SURFACE_STOPS has active predictions for all its routes
  for (const stop of MOCK_SURFACE_STOPS) {
    const list: ArrivalPrediction[] = [];
    for (const routeId of stop.routes) {
      const offsets = [
        Math.floor(Math.random() * 3) + 1,
        Math.floor(Math.random() * 5) + 6,
        Math.floor(Math.random() * 8) + 13,
      ];

      for (let idx = 0; idx < offsets.length; idx++) {
        list.push({
          tripId: `mock_trip_${routeId}_${stop.id}_${idx}`,
          routeId,
          directionId: 0,
          stopSequence: idx + 1,
          predictedTime: nowMs + offsets[idx] * 60 * 1000,
          delaySeconds: 0,
          scheduleRelationship: "SCHEDULED",
          isRealtime: true,
        });
      }
    }
    map.set(stop.id, list);
  }

  return map;
}

/**
 * Helper generating realistic dynamic vehicle positions for mock development routes.
 */
export function generateMockLiveVehicles(nowMs = Date.now()): Map<string, LiveVehiclePosition[]> {
  const map = new Map<string, LiveVehiclePosition[]>();

  map.set("506", [
    {
      vehicleId: "4412",
      routeId: "506",
      directionId: 0,
      latitude: 43.6625,
      longitude: -79.3785,
      bearing: 90,
      speed: 6.2,
      stopId: "14561",
      currentStopSequence: 9,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
    {
      vehicleId: "4428",
      routeId: "506",
      directionId: 0,
      latitude: 43.6595,
      longitude: -79.39,
      bearing: 85,
      speed: 7.5,
      stopId: "14582",
      currentStopSequence: 8,
      currentStatus: "IN_TRANSIT_TO",
      occupancyStatus: "MANY_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
    {
      vehicleId: "4490",
      routeId: "506",
      directionId: 1,
      latitude: 43.6655,
      longitude: -79.3525,
      bearing: 270,
      speed: 6.8,
      stopId: "14583",
      currentStopSequence: 2,
      currentStatus: "IN_TRANSIT_TO",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  map.set("501", [
    {
      vehicleId: "4401",
      routeId: "501",
      directionId: 0,
      latitude: 43.6492,
      longitude: -79.3975,
      bearing: 270,
      speed: 5.8,
      stopId: "14563",
      currentStopSequence: 6,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "STANDING_ROOM_ONLY",
      timestamp: nowMs,
    },
    {
      vehicleId: "4435",
      routeId: "501",
      directionId: 1,
      latitude: 43.6395,
      longitude: -79.4465,
      bearing: 90,
      speed: 7.2,
      stopId: "14591",
      currentStopSequence: 2,
      currentStatus: "IN_TRANSIT_TO",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  map.set("504", [
    {
      vehicleId: "4502",
      routeId: "504",
      directionId: 0,
      latitude: 43.6483,
      longitude: -79.3802,
      bearing: 270,
      speed: 4.2,
      stopId: "14564",
      currentStopSequence: 4,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
    {
      vehicleId: "4510",
      routeId: "504",
      directionId: 1,
      latitude: 43.6483,
      longitude: -79.3802,
      bearing: 90,
      speed: 5.5,
      stopId: "14564",
      currentStopSequence: 7,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "MANY_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  map.set("506", [
    {
      vehicleId: "4050",
      routeId: "506",
      directionId: 0,
      latitude: 43.6655,
      longitude: -79.3705,
      bearing: 90,
      speed: 6.2,
      stopId: "14561",
      currentStopSequence: 1,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
    {
      vehicleId: "4055",
      routeId: "506",
      directionId: 1,
      latitude: 43.6655,
      longitude: -79.3705,
      bearing: 270,
      speed: 5.9,
      stopId: "14561",
      currentStopSequence: 1,
      currentStatus: "IN_TRANSIT_TO",
      occupancyStatus: "MANY_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  map.set("97", [
    {
      vehicleId: "8412",
      routeId: "97",
      directionId: 0,
      latitude: 43.6715,
      longitude: -79.3862,
      bearing: 0,
      speed: 8.3,
      stopId: "14560",
      currentStopSequence: 5,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "MANY_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
    {
      vehicleId: "8488",
      routeId: "97",
      directionId: 1,
      latitude: 43.7255,
      longitude: -79.402,
      bearing: 180,
      speed: 9.1,
      stopId: "14571",
      currentStopSequence: 4,
      currentStatus: "IN_TRANSIT_TO",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  map.set("93", [
    {
      vehicleId: "8520",
      routeId: "93",
      directionId: 0,
      latitude: 43.6868,
      longitude: -79.3132,
      bearing: 45,
      speed: 5.5,
      stopId: "14562",
      currentStopSequence: 1,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "EMPTY",
      timestamp: nowMs,
    },
    {
      vehicleId: "8525",
      routeId: "93",
      directionId: 1,
      latitude: 43.702,
      longitude: -79.319,
      bearing: 225,
      speed: 6.0,
      stopId: "14599",
      currentStopSequence: 1,
      currentStatus: "IN_TRANSIT_TO",
      occupancyStatus: "MANY_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  map.set("91", [
    {
      vehicleId: "8530",
      routeId: "91",
      directionId: 0,
      latitude: 43.6872,
      longitude: -79.3135,
      bearing: 0,
      speed: 6.8,
      stopId: "14565",
      currentStopSequence: 2,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
    {
      vehicleId: "8535",
      routeId: "91",
      directionId: 1,
      latitude: 43.702,
      longitude: -79.319,
      bearing: 180,
      speed: 7.4,
      stopId: "14599",
      currentStopSequence: 1,
      currentStatus: "IN_TRANSIT_TO",
      occupancyStatus: "MANY_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  map.set("510", [
    {
      vehicleId: "4488",
      routeId: "510",
      directionId: 0,
      latitude: 43.6488,
      longitude: -79.397,
      bearing: 180,
      speed: 6.0,
      stopId: "14566",
      currentStopSequence: 6,
      currentStatus: "INCOMING_AT",
      occupancyStatus: "STANDING_ROOM_ONLY",
      timestamp: nowMs,
    },
    {
      vehicleId: "4495",
      routeId: "510",
      directionId: 1,
      latitude: 43.6385,
      longitude: -79.393,
      bearing: 0,
      speed: 7.0,
      stopId: "14598",
      currentStopSequence: 1,
      currentStatus: "STOPPED_AT",
      occupancyStatus: "FEW_SEATS_AVAILABLE",
      timestamp: nowMs,
    },
  ]);

  return map;
}
