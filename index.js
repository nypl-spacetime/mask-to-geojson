const H = require('highland')
const got = require('got')
const JSONStream = require('JSONStream')
const spawn = require('child_process').spawn
const XmlStream = require('xml-stream')

const GOT_OPTIONS = {
  timeout: 25 * 1000,
  retries: 5
}

module.exports.DEFAULT_MAPWARPER_URL = 'http://maps.nypl.org/'

module.exports.gdalInstalled = function (callback) {
  const gdal = spawn('gdaltransform', ['--version'])
  gdal.on('error', callback)
  gdal.stdout.on('data', (data) => callback(null, String(data)))
}

module.exports.getMask = function (params, callback) {
  const mapwarperUrl = params.mapwarperUrl || this.DEFAULT_MAPWARPER_URL
  const mapId = params.mapId
  const url = `${mapwarperUrl}shared/masks/${mapId}.gml`

  let masks = []
  let error = false

  const gmlStream = got.stream(url, GOT_OPTIONS)

  gmlStream.on('error', (err) => {
    if (!error) {
      error = true
      callback(new Error(`error reading mask from Map Warper API: '${err.message}' - see ${url}`))
    }
  })

  const xml = new XmlStream(gmlStream)

  xml.on('error', (err) => {
    if (!error) {
      error = true
      callback(new Error(`error reading mask XML file: '${err.message}' - see ${url}`))
    }
  })

  xml.on('endElement: gml:coordinates', (item) => {
    const maskString = item['$text']
    if (maskString) {
      const match = maskString.match(/(-?\d*\.?\d*\s*,\s*-?\d*\.?\d*)/g)
      if (match) {
        const mask = match
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

        const mask = masks[0]

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

  let error = false

  const gcpStream = got.stream(url, GOT_OPTIONS)

  gcpStream.on('error', (err) => {
    if (!error) {
      error = true
      callback(new Error(`error reading GCPs from Map Warper API: '${err.message}' - see ${url}`))
    }
  })

  const gcpJSONStream = gcpStream
    .pipe(JSONStream.parse('items.*'))

  H(gcpJSONStream)
    .stopOnError((err) => {
      if (!error) {
        error = true
        callback(err)
      }
    })
    .filter((gcp) => Math.abs(gcp.x) > Number.EPSILON && Math.abs(gcp.y) > Number.EPSILON)
    .map((gcp) => [gcp.x, gcp.y, gcp.lat, gcp.lon].map((num) => parseFloat(num)))
    .toArray((gcps) => {
      if (!error) {
        if (gcps.length < 3) {
          callback(new Error(`Map with less than 3 GCPs encountered: ${mapId} - see ${url}`))
        } else {
          callback(null, gcps)
        }
      }
    })
}

const transformArgs = {
  auto: '',
  p1: '-order 1',
  p2: '-order 2',
  p3: '-order 3',
  tps: '-tps'
}

module.exports.transform = function (mask, gcps, params, callback) {
  if (!params) {
    params = {}
  }

  let gdalArgs = []
  gcps.forEach((gcp) => {
    gdalArgs.push('-gcp')
    gdalArgs = gdalArgs.concat(gcp)
  })

  if (params.transform) {
    const transformArg = transformArgs[params.transform]

    if (transformArg === undefined) {
      callback(new Error('Transform option is invalid: ' + params.transform))
      return
    }

    if (transformArg.length) {
      gdalArgs = gdalArgs.concat(transformArg.split(' '))
    }
  }

  let error = false
  const gdal = spawn('gdaltransform', gdalArgs)
  gdal.stdin.setEncoding('utf-8')

  gdal.on('error', (err) => {
    error = true
    callback(new Error('Error spawning gdaltransform - is GDAL installed? ' + err.message))
  })

  H(gdal.stdout)
    .split()
    .compact()
    // each line contains latitude, longitude and elevation
    .map((line) => line.split(' ').slice(0, 2).map(parseFloat))
    .map((latLon) => [latLon[1], latLon[0]])
    .toArray((coordinates) => {
      if (!error) {
        callback(null, {
          type: 'Polygon',
          coordinates: [
            coordinates
          ]
        })
      }
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
          this.transform(mask, gcps, params, (err, geojson) => {
            if (err) {
              callback(err)
            } else {
              callback(null, geojson, gcps, mask)
            }
          })
        }
      })
    }
  })
}
