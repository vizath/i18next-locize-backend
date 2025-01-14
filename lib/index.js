import { defaults, debounce, isMissingOption, interpolate, getPath, setPath, pushPath } from './utils.js'
import request from './request.js'

const getDefaults = () => {
  return {
    loadPath: 'https://api.locize.app/{{projectId}}/{{version}}/{{lng}}/{{ns}}',
    privatePath: 'https://api.locize.app/private/{{projectId}}/{{version}}/{{lng}}/{{ns}}',
    getLanguagesPath: 'https://api.locize.app/languages/{{projectId}}',
    addPath: 'https://api.locize.app/missing/{{projectId}}/{{version}}/{{lng}}/{{ns}}',
    updatePath: 'https://api.locize.app/update/{{projectId}}/{{version}}/{{lng}}/{{ns}}',
    referenceLng: 'en',
    crossDomain: true,
    setContentTypeJSON: false,
    version: 'latest',
    private: false,
    translatedPercentageThreshold: 0.9,
    // temporal backwards compatibility WHITELIST REMOVAL
    whitelistThreshold: 0.9,
    // end temporal backwards compatibility WHITELIST REMOVAL
    failLoadingOnEmptyJSON: false, // useful if using chained backend
    allowedAddOrUpdateHosts: ['localhost'],
    onSaved: false,
    reloadInterval: typeof window !== 'undefined' ? false : 60 * 60 * 1000,
    checkForProjectTimeout: 3 * 1000,
    storageExpiration: 60 * 60 * 1000,
    writeDebounce: 5 * 1000
  }
}

let hasLocalStorageSupport
try {
  hasLocalStorageSupport = typeof window !== 'undefined' && window.localStorage !== null
  const testKey = 'notExistingLocizeProject'
  window.localStorage.setItem(testKey, 'foo')
  window.localStorage.removeItem(testKey)
} catch (e) {
  hasLocalStorageSupport = false
}

function getStorage (storageExpiration) {
  let setProjectNotExisting = () => {}
  let isProjectNotExisting = () => {}
  if (hasLocalStorageSupport) {
    setProjectNotExisting = (projectId) => {
      window.localStorage.setItem(`notExistingLocizeProject_${projectId}`, Date.now())
    }
    isProjectNotExisting = (projectId) => {
      const ret = window.localStorage.getItem(`notExistingLocizeProject_${projectId}`)
      if (!ret) return false
      if (Date.now() - ret > storageExpiration) {
        window.localStorage.removeItem(`notExistingLocizeProject_${projectId}`)
        return false
      }
      return true
    }
  } else if (typeof document !== 'undefined') {
    setProjectNotExisting = (projectId) => {
      const date = new Date()
      date.setTime(date.getTime() + storageExpiration)
      const expires = `; expires=${date.toGMTString()}`
      const name = `notExistingLocizeProject_${projectId}`
      try { // ignore if running in strange environments
        document.cookie = `${name}=${Date.now()}${expires};path=/`
      } catch (err) {}
    }
    isProjectNotExisting = (projectId) => {
      const name = `notExistingLocizeProject_${projectId}`
      const nameEQ = `${name}=`
      try { // ignore if running in strange environments
        const ca = document.cookie.split(';')
        for (let i = 0; i < ca.length; i++) {
          let c = ca[i]
          while (c.charAt(0) === ' ') c = c.substring(1, c.length)
          if (c.indexOf(nameEQ) === 0) return true // return c.substring(nameEQ.length,c.length);
        }
      } catch (err) {}
      return false
    }
  }

  return {
    setProjectNotExisting,
    isProjectNotExisting
  }
}

class I18NextLocizeBackend {
  constructor (services, options = {}, allOptions = {}, callback) {
    this.services = services
    this.options = options
    this.allOptions = allOptions
    this.type = 'backend'
    if (services && services.projectId) {
      this.init(null, services, allOptions, options)
    } else {
      this.init(services, options, allOptions, callback)
    }
  }

  init (services, options = {}, allOptions = {}, callback) {
    this.services = services
    // temporal backwards compatibility WHITELIST REMOVAL
    if (options.whitelistThreshold !== undefined && options.translatedPercentageThreshold === undefined) {
      if (services && services.logger) services.logger.deprecate('whitelistThreshold', 'option "whitelistThreshold" will be renamed to "translatedPercentageThreshold" in the next major - please make sure to rename this option asap.')
      options.translatedPercentageThreshold = options.whitelistThreshold
    }
    // end temporal backwards compatibility WHITELIST REMOVAL
    this.options = defaults(options, this.options || {}, getDefaults())
    this.allOptions = allOptions
    this.somethingLoaded = false
    this.isProjectNotExisting = false
    this.storage = getStorage(this.options.storageExpiration)

    if (this.options.pull) {
      console.warn(
        'The pull API was removed use "private: true" option instead: https://docs.locize.com/integration/api#fetch-private-namespace-resources'
      )
    }

    const hostname = typeof window !== 'undefined' && window.location && window.location.hostname
    if (hostname) {
      this.isAddOrUpdateAllowed = typeof this.options.allowedAddOrUpdateHosts === 'function' ? this.options.allowedAddOrUpdateHosts(hostname) : this.options.allowedAddOrUpdateHosts.indexOf(hostname) > -1

      if (services && services.logger && (allOptions.saveMissing || allOptions.updateMissing)) {
        if (!this.isAddOrUpdateAllowed) {
          services.logger.warn(
            typeof this.options.allowedAddOrUpdateHosts === 'function'
              ? `locize-backend: will not save or update missings because allowedAddOrUpdateHosts returned false for the host "${hostname}".`
              : `locize-backend: will not save or update missings because the host "${hostname}" was not in the list of allowedAddOrUpdateHosts: ${this.options.allowedAddOrUpdateHosts.join(
                ', '
              )} (matches need to be exact).`
          )
        } else if (hostname !== 'localhost') {
          services.logger.warn(`locize-backend: you are using the save or update missings feature from this host "${hostname}".\nMake sure you will not use it in production!\nhttps://docs.locize.com/guides-tips-and-tricks/going-production`)
        }
      }
    } else {
      this.isAddOrUpdateAllowed = true
    }

    if (typeof callback === 'function') {
      this.getOptions((err, opts, languages) => {
        if (err) return callback(err)
        this.options.referenceLng = options.referenceLng || opts.referenceLng || this.options.referenceLng
        callback(null, opts, languages)
      })
    }

    this.queuedWrites = { pending: {} }
    this.debouncedProcess = debounce(this.process, this.options.writeDebounce)

    if (this.interval) clearInterval(this.interval)
    if (this.options.reloadInterval && this.options.projectId) {
      this.interval = setInterval(() => this.reload(), this.options.reloadInterval)
    }
  }

  reload () {
    const { backendConnector, languageUtils, logger } = this.services || { logger: console }
    if (!backendConnector) return
    const currentLanguage = backendConnector.language
    if (currentLanguage && currentLanguage.toLowerCase() === 'cimode') return // avoid loading resources for cimode

    const toLoad = []
    const append = (lng) => {
      const lngs = languageUtils.toResolveHierarchy(lng)
      lngs.forEach(l => {
        if (toLoad.indexOf(l) < 0) toLoad.push(l)
      })
    }

    append(currentLanguage)

    if (this.allOptions.preload) this.allOptions.preload.forEach((l) => append(l))

    toLoad.forEach(lng => {
      this.allOptions.ns.forEach(ns => {
        backendConnector.read(lng, ns, 'read', null, null, (err, data) => {
          if (err) logger.warn(`loading namespace ${ns} for language ${lng} failed`, err)
          if (!err && data) logger.log(`loaded namespace ${ns} for language ${lng}`, data)

          backendConnector.loaded(`${lng}|${ns}`, err, data)
        })
      })
    })
  }

  getLanguages (callback) {
    const isMissing = isMissingOption(this.options, ['projectId'])
    if (isMissing) return callback(new Error(isMissing))

    const url = interpolate(this.options.getLanguagesPath, {
      projectId: this.options.projectId
    })

    if (!this.isProjectNotExisting && this.storage.isProjectNotExisting(this.options.projectId)) {
      this.isProjectNotExisting = true
    }

    if (this.isProjectNotExisting) return callback(new Error(`locize project ${this.options.projectId} does not exist!`))

    this.loadUrl({}, url, (err, ret, info) => {
      if (!this.somethingLoaded && info && info.resourceNotExisting) {
        this.isProjectNotExisting = true
        this.storage.setProjectNotExisting(this.options.projectId)
        return callback(new Error(`locize project ${this.options.projectId} does not exist!`))
      }
      this.somethingLoaded = true
      callback(err, ret)
    })
  }

  getOptions (callback) {
    this.getLanguages((err, data) => {
      if (err) return callback(err)
      const keys = Object.keys(data)
      if (!keys.length) { return callback(new Error('was unable to load languages via API')) }

      const referenceLng = keys.reduce((mem, k) => {
        const item = data[k]
        if (item.isReferenceLanguage) mem = k
        return mem
      }, '')

      const lngs = keys.reduce((mem, k) => {
        const item = data[k]
        if (
          item.translated[this.options.version] &&
          item.translated[this.options.version] >=
            this.options.translatedPercentageThreshold
        ) { mem.push(k) }
        return mem
      }, [])

      const hasRegion = keys.reduce((mem, k) => {
        if (k.indexOf('-') > -1) return true
        return mem
      }, false)

      callback(null, {
        fallbackLng: referenceLng,
        referenceLng,
        supportedLngs: lngs,
        // temporal backwards compatibility WHITELIST REMOVAL
        whitelist: lngs,
        // end temporal backwards compatibility WHITELIST REMOVAL
        load: hasRegion ? 'all' : 'languageOnly'
      }, data)
    })
  }

  checkIfProjectExists (callback) {
    const { logger } = this.services || { logger: console }
    if (this.somethingLoaded) {
      if (callback) callback(null)
      return
    }
    if (this.alreadyRequestedCheckIfProjectExists) {
      setTimeout(() => this.checkIfProjectExists(callback), this.options.checkForProjectTimeout)
      return
    }
    this.alreadyRequestedCheckIfProjectExists = true
    this.getLanguages((err) => {
      if (err && err.message && err.message.indexOf('does not exist') > 0) {
        if (logger) logger.error(err.message)
      }
      if (callback) callback(err)
    })
  }

  read (language, namespace, callback) {
    const { logger } = this.services || { logger: console }
    let url
    let options = {}
    if (this.options.private) {
      const isMissing = isMissingOption(this.options, ['projectId', 'version', 'apiKey'])
      if (isMissing) return callback(new Error(isMissing), false)

      url = interpolate(this.options.privatePath, {
        lng: language,
        ns: namespace,
        projectId: this.options.projectId,
        version: this.options.version
      })
      options = { authorize: true }
    } else {
      const isMissing = isMissingOption(this.options, ['projectId', 'version'])
      if (isMissing) return callback(new Error(isMissing), false)

      url = interpolate(this.options.loadPath, {
        lng: language,
        ns: namespace,
        projectId: this.options.projectId,
        version: this.options.version
      })
    }

    if (!this.isProjectNotExisting && this.storage.isProjectNotExisting(this.options.projectId)) {
      this.isProjectNotExisting = true
    }

    if (this.isProjectNotExisting) {
      const err = new Error(`locize project ${this.options.projectId} does not exist!`)
      if (logger) logger.error(err.message)
      if (callback) callback(err)
      return
    }

    this.loadUrl(options, url, (err, ret, info) => {
      if (!this.somethingLoaded) {
        if (info && info.resourceNotExisting) {
          setTimeout(() => this.checkIfProjectExists(), this.options.checkForProjectTimeout)
        } else {
          this.somethingLoaded = true
        }
      }
      callback(err, ret)
    })
  }

  loadUrl (options, url, payload, callback) {
    options = defaults(options, this.options)
    if (typeof payload === 'function') {
      callback = payload
      payload = undefined
    }
    callback = callback || (() => {})
    request(options, url, payload, (err, res) => {
      const resourceNotExisting = res && res.resourceNotExisting

      if (res && (res.status === 408 || res.status === 400)) { // extras for timeouts on cloudfront
        return callback('failed loading ' + url, true /* retry */, { resourceNotExisting })
      }
      if (res && ((res.status >= 500 && res.status < 600) || !res.status)) { return callback('failed loading ' + url, true /* retry */, { resourceNotExisting }) }
      if (res && res.status >= 400 && res.status < 500) { return callback('failed loading ' + url, false /* no retry */, { resourceNotExisting }) }
      if (!res && err && err.message && err.message.indexOf('Failed to fetch') > -1) { return callback('failed loading ' + url, true /* retry */, { resourceNotExisting }) }
      if (err) return callback(err, false)

      let ret, parseErr
      try {
        ret = JSON.parse(res.data)
      } catch (e) {
        parseErr = 'failed parsing ' + url + ' to json'
      }
      if (parseErr) return callback(parseErr, false)
      if (this.options.failLoadingOnEmptyJSON && !Object.keys(ret).length) { return callback('loaded result empty for ' + url, false, { resourceNotExisting }) }
      callback(null, ret, { resourceNotExisting })
    })
  }

  create (languages, namespace, key, fallbackValue, callback, options) {
    if (!callback) callback = () => {}

    this.checkIfProjectExists((err) => {
      if (err) return callback(err)

      // missing options
      const isMissing = isMissingOption(this.options, ['projectId', 'version', 'apiKey', 'referenceLng'])
      if (isMissing) return callback(new Error(isMissing))

      // unallowed host
      if (!this.isAddOrUpdateAllowed) { return callback('host is not allowed to create key.') }

      if (typeof languages === 'string') languages = [languages]

      if (languages.filter(l => l === this.options.referenceLng).length < 1) {
        this.services &&
          this.services.logger &&
          this.services.logger.warn(
            `locize-backend: will not save missings because the reference language "${
              this.options.referenceLng
            }" was not in the list of to save languages: ${languages.join(
              ', '
            )} (open your site in the reference language to save missings).`
          )
      }

      languages.forEach(lng => {
        if (lng === this.options.referenceLng) {
          // eslint-disable-next-line no-useless-call
          this.queue.call(
            this,
            this.options.referenceLng,
            namespace,
            key,
            fallbackValue,
            callback,
            options
          )
        }
      })
    })
  }

  update (languages, namespace, key, fallbackValue, callback, options) {
    if (!callback) callback = () => {}

    this.checkIfProjectExists((err) => {
      if (err) return callback(err)

      // missing options
      const isMissing = isMissingOption(this.options, ['projectId', 'version', 'apiKey', 'referenceLng'])
      if (isMissing) return callback(new Error(isMissing))

      if (!this.isAddOrUpdateAllowed) { return callback('host is not allowed to update key.') }

      if (!options) options = {}
      if (typeof languages === 'string') languages = [languages]

      // mark as update
      options.isUpdate = true

      languages.forEach(lng => {
        if (lng === this.options.referenceLng) {
          // eslint-disable-next-line no-useless-call
          this.queue.call(
            this,
            this.options.referenceLng,
            namespace,
            key,
            fallbackValue,
            callback,
            options
          )
        }
      })
    })
  }

  writePage (lng, namespace, missings, callback) {
    const missingUrl = interpolate(this.options.addPath, {
      lng: lng,
      ns: namespace,
      projectId: this.options.projectId,
      version: this.options.version
    })
    const updatesUrl = interpolate(this.options.updatePath, {
      lng: lng,
      ns: namespace,
      projectId: this.options.projectId,
      version: this.options.version
    })

    let hasMissing = false
    let hasUpdates = false
    const payloadMissing = {}
    const payloadUpdate = {}

    missings.forEach(item => {
      const value =
        item.options && item.options.tDescription
          ? {
              value: item.fallbackValue || '',
              context: { text: item.options.tDescription }
            }
          : item.fallbackValue || ''
      if (item.options && item.options.isUpdate) {
        if (!hasUpdates) hasUpdates = true
        payloadUpdate[item.key] = value
      } else {
        if (!hasMissing) hasMissing = true
        payloadMissing[item.key] = value
      }
    })

    let todo = 0
    if (hasMissing) todo++
    if (hasUpdates) todo++
    const doneOne = (err) => {
      todo--
      if (!todo) callback(err)
    }

    if (!todo) doneOne()

    if (hasMissing) {
      request(
        defaults({ authorize: true }, this.options),
        missingUrl,
        payloadMissing,
        doneOne
      )
    }

    if (hasUpdates) {
      request(
        defaults({ authorize: true }, this.options),
        updatesUrl,
        payloadUpdate,
        doneOne
      )
    }
  }

  write (lng, namespace) {
    const lock = getPath(this.queuedWrites, ['locks', lng, namespace])
    if (lock) return

    const missings = getPath(this.queuedWrites, [lng, namespace])
    setPath(this.queuedWrites, [lng, namespace], [])
    const pageSize = 1000

    const clbs = missings.filter(m => m.callback).map(missing => missing.callback)

    if (missings.length) {
      // lock
      setPath(this.queuedWrites, ['locks', lng, namespace], true)

      const namespaceSaved = () => {
        // unlock
        setPath(this.queuedWrites, ['locks', lng, namespace], false)

        clbs.forEach(clb => clb())

        // emit notification onSaved
        if (this.options.onSaved) this.options.onSaved(lng, namespace)

        // rerun
        this.debouncedProcess(lng, namespace)
      }

      const amountOfPages = missings.length / pageSize
      let pagesDone = 0

      let page = missings.splice(0, pageSize)
      this.writePage(lng, namespace, page, () => {
        pagesDone++
        if (pagesDone >= amountOfPages) namespaceSaved()
      })
      while (page.length === pageSize) {
        page = missings.splice(0, pageSize)
        if (page.length) {
          this.writePage(lng, namespace, page, () => {
            pagesDone++
            if (pagesDone >= amountOfPages) namespaceSaved()
          })
        }
      }
    }
  }

  process () {
    Object.keys(this.queuedWrites).forEach(lng => {
      if (lng === 'locks') return
      Object.keys(this.queuedWrites[lng]).forEach(ns => {
        const todo = this.queuedWrites[lng][ns]
        if (todo.length) {
          this.write(lng, ns)
        }
      })
    })
  }

  queue (lng, namespace, key, fallbackValue, callback, options) {
    pushPath(this.queuedWrites, [lng, namespace], {
      key: key,
      fallbackValue: fallbackValue || '',
      callback: callback,
      options
    })

    this.debouncedProcess()
  }
}

I18NextLocizeBackend.type = 'backend'

export default I18NextLocizeBackend
