module.exports = function sharp() {
  throw new Error('sharp is not available - image processing not supported')
}

module.exports.sharp = module.exports
module.exports.default = module.exports
