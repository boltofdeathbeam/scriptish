const DESCRIPTION = "ScriptishService";
const CONTRACTID = "@scriptish.erikvold.com/scriptish-service;1";
const CLASSID = Components.ID("{ca39e060-88ab-11df-a4ee-0800200c9a66}");

const filename = Components.stack.filename;

const Cu = Components.utils;
Cu.import("resource://scriptish/constants.js");

lazyImport(this, "resource://scriptish/logging.js", ["Scriptish_logError", "Scriptish_logScriptError"]);
lazyImport(this, "resource://scriptish/prefmanager.js", ["Scriptish_prefRoot"]);
lazyImport(this, "resource://scriptish/scriptish.js", ["Scriptish"]);
lazyImport(this, "resource://scriptish/manager.js", ["Scriptish_manager"]);
lazyImport(this, "resource://scriptish/config.js", ["Scriptish_config"]);
lazyImport(this, "resource://scriptish/api.js", ["GM_API"]);
lazyImport(this, "resource://scriptish/api/GM_sandboxScripts.js", ["GM_sandboxScripts"]);
lazyImport(this, "resource://scriptish/api/GM_console.js", ["GM_console"]);
lazyImport(this, "resource://scriptish/api/GM_ScriptLogger.js", ["GM_ScriptLogger"]);
lazyImport(this, "resource://scriptish/third-party/Timer.js", ["Timer"]);
lazyImport(this, "resource://scriptish/third-party/Scriptish_getBrowserForContentWindow.js", ["Scriptish_getBrowserForContentWindow"]);

lazyUtil(this, "evalInSandbox");
lazyUtil(this, "installUri");
lazyUtil(this, "isScriptRunnable");
lazyUtil(this, "getWindowIDs");
lazyUtil(this, "stringBundle");

const {nsIContentPolicy: CP, nsIDOMXPathResult: XPATH_RESULT} = Ci;
const docRdyStates = ["uninitialized", "loading", "loaded", "interactive", "complete"];

// If the file was previously cached it might have been given a number after
// .user, like gmScript.user-12.js
const RE_USERSCRIPT = /\.user(?:-\d+)?\.js$/;
const RE_CONTENTTYPE = /text\/html/i;

let windows = {};

function ScriptishService() {
  this.wrappedJSObject = this;
  this.timer = new Timer();
  this.updateChk = function() {
    Services.scriptloader
        .loadSubScript("chrome://scriptish/content/js/updatecheck.js");
    delete this.updateChk;
  }

  if (!e10s)
    Services.obs.addObserver(this, "chrome-document-global-created", false);
  Services.obs.addObserver(this, "content-document-global-created", false);
  Services.obs.addObserver(this, "inner-window-destroyed", false);
  Services.obs.addObserver(this, "install-userscript", false);
  Services.obs.addObserver(this, "scriptish-enabled", false);
}

ScriptishService.prototype = {
  classDescription: DESCRIPTION,
  classID: CLASSID,
  contractID: CONTRACTID,
  _xpcom_categories: [{
    category: "content-policy",
    entry: CONTRACTID,
    value: CONTRACTID,
    service: true
  }],
  QueryInterface: XPCOMUtils.generateQI([
      Ci.nsISupports, Ci.nsISupportsWeakReference, Ci.nsIContentPolicy]),

  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
      case "chrome-document-global-created":
      case "content-document-global-created":
        this.docReady(aSubject, Scriptish_getBrowserForContentWindow(aSubject).wrappedJSObject);
        break;
      case "inner-window-destroyed":
        this.innerWinDestroyed(aSubject.QueryInterface(Components.interfaces.nsISupportsPRUint64).data);
        break;
      case "install-userscript":
        let win = Scriptish.getMostRecentWindow("navigator:browser");
        if (win) win.Scriptish_BrowserUI.installCurrentScript();
        break;
      case "scriptish-enabled":
        aData = JSON.parse(aData);
        let bWins = Scriptish.getWindows();
        let on = aData.enabling;
        while (bWins.hasMoreElements()) {
          let bWin = bWins.getNext();
          bWin.Scriptish_BrowserUI.statusCasterEle.setAttribute("checked", on.toString());
          bWin.Scriptish_BrowserUIM.refreshStatus();
        }
        break;
    }
  },

  get filename() filename,

  innerWinDestroyed: function(aWinID) {
    let window = windows[aWinID];
    if (!window || !window.unloaders || !window.unloaders.length) return;
    for (var i = window.unloaders.length - 1; ~i; i--)
      window.unloaders[i]();
    delete windows[aWinID];
  },

  docReady: function(safeWin, chromeWin) {
    if (!Scriptish.enabled || !chromeWin) return;

    let gmBrowserUI = chromeWin.Scriptish_BrowserUI;
    let gBrowser = chromeWin.gBrowser;
    if (!gmBrowserUI || !gBrowser) return;

    let currentInnerWindowID = Scriptish_getWindowIDs(safeWin).innerID;
    windows[currentInnerWindowID] = {unloaders: []};

    let href = (safeWin.location.href
        || (safeWin.frameElement && safeWin.frameElement.src))
        || "";

    if (!href && safeWin.frameElement) {
      Scriptish_manager.waitForFrame.call(this, safeWin, chromeWin);
      return;
    }

    // Show the scriptish install banner if the user is navigating to a .user.js
    // file in a top-level tab.
    if (safeWin === safeWin.top && RE_USERSCRIPT.test(href)
        && !RE_CONTENTTYPE.test(safeWin.document.contentType)) {
      gmBrowserUI.showInstallBanner(
          gBrowser.getBrowserForDocument(safeWin.document));
    }

    if (!Scriptish.isGreasemonkeyable(href)) return;

    let unsafeWin = safeWin.wrappedJSObject;
    let self = this;
    let winClosed = false;
    let isTop = (safeWin === safeWin.top);

    // rechecks values that can change at any moment
    function shouldNotRun() (
      winClosed || !Scriptish.enabled || !Scriptish.isGreasemonkeyable(href));

    // check if there are any modified scripts
    if (Scriptish_prefRoot.getValue("enableScriptRefreshing")) {
       Scriptish_config.updateModifiedScripts(function(script) {
        if (shouldNotRun()
            || !Scriptish_isScriptRunnable(script, href, isTop))
          return;

        let rdyStateIdx = docRdyStates.indexOf(safeWin.document.readyState);
        function inject() {
          if (shouldNotRun()) return;
          self.injectScripts([script], href, currentInnerWindowID, safeWin, chromeWin);
        }
        switch (script.runAt) {
        case "document-end":
          if (2 > rdyStateIdx) {
            safeWin.addEventListener("DOMContentLoaded", inject, true);
            return;
          }
          break;
        case "document-idle":
          if (2 > rdyStateIdx) {
            safeWin.addEventListener(
                "DOMContentLoaded", function() timeout(inject), true);
            return;
          }
          break;
        case "window-load":
          if (4 > rdyStateIdx) {
            safeWin.addEventListener("load", inject, true);
            return;
          }
          break;
        }
        inject();
      });
    }

    // if the focused tab's window is the one loading, then attach menuCommander
    if (safeWin === gBrowser.selectedBrowser.contentWindow) {
      if (gmBrowserUI.currentMenuCommander)
        gmBrowserUI.currentMenuCommander.detach();
      gmBrowserUI.currentMenuCommander =
          gmBrowserUI.getCommander(currentInnerWindowID).attach();
    }

    // if the url is a excluded url then stop
    if (Scriptish_config.isURLExcluded(href)) return;

    // find matching scripts
    Scriptish_config.initScripts(href, isTop, function(scripts) {
      if (scripts["document-end"].length || scripts["document-idle"].length) {
        safeWin.addEventListener("DOMContentLoaded", function() {
          if (shouldNotRun()) return;

          // inject @run-at document-idle scripts
          if (scripts["document-idle"].length)
            timeout(function() {
              if (shouldNotRun()) return;
              self.injectScripts(
                  scripts["document-idle"], href, currentInnerWindowID, safeWin, chromeWin);
            });

          // inject @run-at document-end scripts
          self.injectScripts(scripts["document-end"], href, currentInnerWindowID, safeWin, chromeWin);
        }, true);
      }

      if (scripts["window-load"].length) {
        safeWin.addEventListener("load", function() {
          if (shouldNotRun()) return;
          // inject @run-at window-load scripts
          self.injectScripts(scripts["window-load"], href, currentInnerWindowID, safeWin, chromeWin);
        }, true);
      }

      // inject @run-at document-start scripts
      self.injectScripts(scripts["document-start"], href, currentInnerWindowID, safeWin, chromeWin);

      windows[currentInnerWindowID].unloaders.push(function() {
        winClosed = true;
        gmBrowserUI.docUnload(currentInnerWindowID);
      });
    });
  },

  _test_org: {
    "chrome": true,
    "about": true
  },
  _test_cl: {
    "chrome": true,
    "resource": true
  },
  _reg_userjs: /\.user\.js$/,
  shouldLoad: function(ct, cl, org, ctx, mt, ext) {
    // block content detection of scriptish by denying it chrome: & resource:
    // content, unless loaded from chrome: or about:
    if (org && !this._test_org[org.scheme]
        && this._test_cl[cl.scheme]
        && cl.host == "scriptish") {
      return CP.REJECT_SERVER;
    }

    // don't intercept anything when Scriptish is not enabled
    if (!Scriptish.enabled) return CP.ACCEPT;
    // don't interrupt the view-source: scheme
    if ("view-source" == cl.scheme) return CP.ACCEPT;

    // CP.TYPE is not binary, so do not use bitwise logic tricks
    if ((ct == CP.TYPE_DOCUMENT || ct == CP.TYPE_SUBDOCUMENT)
        && this._reg_userjs.test(cl.spec)
        && !this.ignoreNextScript_ && !this.isTempScript(cl)) {
      this.ignoreNextScript_ = false;
      Scriptish_installUri(cl, ctx.contentWindow);
      return CP.REJECT_REQUEST;
    }

    this.ignoreNextScript_ = false;
    return CP.ACCEPT;
  },

  shouldProcess: function(ct, cl, org, ctx, mt, ext) CP.ACCEPT,

  ignoreNextScript: function() this.ignoreNextScript_ = true,

  _tmpDir: Services.dirsvc.get("TmpD", Ci.nsILocalFile),
  isTempScript: function(uri) {
    if (!(uri instanceof Ci.nsIFileURL)) return false;

    var file = uri.file;
    return file.parent.equals(this._tmpDir) && file.leafName != "newscript.user.js";
  },

  injectScripts: function(scripts, url, winID, wrappedContentWin, chromeWin) {
    if (0 >= scripts.length) return;
    let self = this;
    let unsafeContentWin = wrappedContentWin.wrappedJSObject;

    let delays = [];
    let winID = Scriptish_getWindowIDs(wrappedContentWin).innerID;
    windows[winID].unloaders.push(function() {
      for (let [, id] in Iterator(delays)) self.timer.clearTimeout(id);
    });

    for (var i = 0, e = scripts.length; i < e; ++i) {
      // Do not "optimize" |script| out of the loop block and into the loop
      // declaration!
      // Need to keep a valid reference to |script| around so that GM_log
      // and the delay code (and probably other consumer work).
      let script = scripts[i];
      let sandbox = new Cu.Sandbox(wrappedContentWin);
      Cu.evalInSandbox(GM_sandboxScripts, sandbox);

      let GM_api = new GM_API(
          script, url, winID, wrappedContentWin, unsafeContentWin, chromeWin);

      // hack XPathResult since that is so commonly used
      sandbox.XPathResult = XPATH_RESULT;

      // add GM_* API to sandbox
      for (var funcName in GM_api) {
        sandbox[funcName] = GM_api[funcName];
      }
      XPCOMUtils.defineLazyGetter(sandbox, "console", function() {
        return GM_console(script, wrappedContentWin, chromeWin);
      });
      XPCOMUtils.defineLazyGetter(sandbox, "GM_log", function() {
        if (Scriptish_prefRoot.getValue("logToErrorConsole")) {
          var logger = new GM_ScriptLogger(script);
          return function() {
            logger.log(Array.slice(arguments).join(" "));
            sandbox.console.log.apply(sandbox.console, arguments);
          }
        }
        return sandbox.console.log.bind(sandbox.console);
      });

      sandbox.unsafeWindow = unsafeContentWin;
      sandbox.__proto__ = wrappedContentWin;

      let delay = script.delay;
      if (delay || delay === 0) {
        // don't use window's setTimeout, b/c then window could clearTimeout
        delays.push(self.timer.setTimeout(function() {
          Scriptish_evalInSandbox(script, sandbox, wrappedContentWin);
        }, delay));
      } else {
        Scriptish_evalInSandbox(script, sandbox, wrappedContentWin);
      }
    }
  }
}

var NSGetFactory = XPCOMUtils.generateNSGetFactory([ScriptishService]);
