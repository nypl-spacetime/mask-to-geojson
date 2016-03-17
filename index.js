'use strict'

var H = require('highland')
var request = require('request')
var JSONStream = require('JSONStream')
var spawn = require('child_process').spawn
var XmlStream = require('xml-stream')

module.exports.DEFAULT_MAPWARPER_URL = 'http://maps.nypl.org/'

module.exports.getMask = function (params, callback) {
  const mapwarperUrl = params.mapwarperUrl || this.DEFAULT_MAPWARPER_URL
  const mapId = params.mapId
  const url = `${mapwarperUrl}shared/masks/${mapId}.gml`

  var masks = []
  var error = false

  var gmlStream = request(url)
  gmlStream.on('error', (err) => {
    if (!error) {
      error = true
      callback(err)
    }
  })

  var xml = new XmlStream(gmlStream)

  xml.on('error', (err) => {
    if (!error) {
      error = true
      callback(err)
    }
  })

  xml.on('endElement: gml:coordinates', (item) => {
    var maskString = item['$text']
    if (maskString) {
      var match = maskString.match(/(-?\d*\.?\d*\s*,\s*-?\d*\.?\d*)/g)
      if (match) {
        var mask = match
          .map((c) => c.split(','))
          .map((c) => c.map(parseFloat))
        masks.push(mask)
      }
    }
  })

  xml.on('end', () => {
    if (!error) {
      if (!masks.length) {
        callback(new Error(`no coordinates found in mask GML: ${mapId} - see ${url}`))
      } else {
        masks.sort((a, b) => b.length - a.length)

        var mask = masks[0]

        if (mask.length < 4) {
          callback(new Error(`GML mask with less than 4 coordinates encountered: ${mapId} - see ${url}`))
        } else {
          callback(null, masks[0])
        }
      }
    }
  })
}

module.exports.getGcps = function (params, callback) {
  const mapwarperUrl = params.mapwarperUrl || this.DEFAULT_MAPWARPER_URL
  const mapId = params.mapId
  const url = `${mapwarperUrl}warper/maps/${mapId}/gcps.json`

  var gcpStream = request(url, {
    json: true
  }).pipe(JSONStream.parse('items.*'))

  H(gcpStream)
    .errors(callback)
    .filter((gcp) => Math.abs(gcp.x) > Number.EPSILON && Math.abs(gcp.y) > Number.EPSILON)
    .map((gcp) => [gcp.x, gcp.y, gcp.lat, gcp.lon])
    .toArray((gcps) => {
      if (gcps.length < 3) {
        callback(new Error(`Map with less than 3 GCPs encountered: ${mapId} - see ${url}`))
      } else {
        callback(null, gcps)
      }
    })
}

module.exports.transform = function (mask, gcps, callback) {
  var params = []
  gcps.forEach((gcp) => {
    params.push('-gcp')
    params = params.concat(gcp)
  })

  var gdal = spawn('gdaltransform', params)
  gdal.stdin.setEncoding('utf-8')

  H(gdal.stdout)
    .split()
    .compact()
    // each line contains latitude, longitude and elevation
    .map((line) => line.split(' ').slice(0, 2).map(parseFloat))
    .map((latLon) => [latLon[1], latLon[0]])
    .toArray((coordinates) => {
      callback(null, {
        type: 'Polygon',
        coordinates: [
          coordinates
        ]
      })
    })

  mask.forEach((coordinate) => {
    gdal.stdin.write(`${coordinate.join(' ')}\n`)
  })
  gdal.stdin.end()
}

module.exports.getMaskAndTransform = function (params, callback) {
  this.getMask(params, (err, mask) => {
    if (err) {
      callback(err)
    } else {
      this.getGcps(params, (err, gcps) => {
        if (err) {
          callback(err)
        } else {
          this.transform(mask, gcps, callback)
        }
      })
    }
  })
}
