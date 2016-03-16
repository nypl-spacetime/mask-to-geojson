#!/usr/bin/env node

var fs = require('fs')
var argv = require('minimist')(process.argv.slice(2))
var maskToGeoJSON = require('./')

if (!argv._[0]) {
  console.error('Usage: mask-to-geojson [-u mapwarperUrl] [-o file] mapId\n' +
    `  -u    Mapwarper URL - default is ${maskToGeoJSON.DEFAULT_MAPWARPER_URL}\n` +
    '  -o    output file - if not present, mask-to-geojson uses stdout')

  process.exit(1)
}

var mapId = argv._[0]

const mapwarperUrl = argv.u || maskToGeoJSON.DEFAULT_MAPWARPER_URL

maskToGeoJSON.getMaskAndTransform({
  mapwarperUrl: mapwarperUrl,
  mapId: mapId
}, (err, geojson) => {
  if (err) {
    console.error(err)
  } else {
    if (argv.o) {
      fs.writeFileSync(argv.o, JSON.stringify(geojson))
    } else {
      console.log(JSON.stringify(geojson))
    }
  }
})
