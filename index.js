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

  var gmlStream = request(url)
  gmlStream.on('error', callback)
  var xml = new XmlStream(gmlStream)
  xml.on('error', callback)

  var foundCoordinates = false

  xml.on('endElement: gml:coordinates', (item) => {
    foundCoordinates = true

    var maskString = item['$text']
    if (maskString) {
      var match = maskString.match(/(\d*\.?\d*\s*,\s*\d*\.?\d*)/g)
      if (match) {
        var mask = match
          .map((c) => c.split(','))
          .map((c) => c.map(parseFloat))
        callback(null, mask)
      }
    }
  })

  xml.on('end', () => {
    if (!foundCoordinates) {
      callback(new Error('no coordinates found in mask GML'))
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
    .map((gcp) => [gcp.x, gcp.y, gcp.lat, gcp.lon])
    .toArray((gcps) => {
      callback(null, gcps)
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
