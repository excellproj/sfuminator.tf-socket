module.exports = Sfuminator;
var events = require('events');
var CFG = require('./cfg.js');
var Logs = require('./lib/logs.js');
var Users = require('./modules/users.js');
var Shop = require('./modules/shop.js');
var TradeConstants = require("./modules/trade/tradeConstants.js");
var BotsController = require('./modules/controllers/botsController.js');
var AjaxResponses = require('./modules/ajaxResponses.js');
var Stats = require('./modules/stats.js');
var TradeStatus = require('./modules/trade/status.js');
var Interrupts = require('./lib/interrupts.js');
var BotPorting = require('./v3_bot_porting.js');

var Valve = require("./valve.js");

/**
 * General purpose Sfuminator class
 * @param {WebApi} webApi
 * @param {Database} db
 * @returns {Sfuminator}
 * @construct
 */
function Sfuminator(webApi, db) {
    this.webApi = webApi;
    this.db = db;
    this.log = new Logs({applicationName: "Sfuminator", color: "blue"});
    this.log.setLevel(0);
    this.admins = CFG.getAdmins();
    this.interrupts = new Interrupts([
        {name: "updatePrices", delay: 60 * 1000, tag: "internal"},  //1 Minute
        {name: "updateKeyPrice", delay: 2 * 60 * 60 * 1000, tag: "global"}, // 2 Hours
        {name: "updateTF2Data", delay: 3 * 60 * 60 * 1000, tag: "global"}, //3 Hours
        {name: "updateShopInventory", delay: 4 * 1000, tag: "internal"}, //4 Seconds
        {name: "updateActiveTrades", delay: 1.5 * 1000, tag: "internal"}, //1.5 Seconds
        {name: "updateStats", delay: 1000, tag: "global"},  //1 Second
        {name: "updateTradeStatus", delay: 1000, tag: "global"}, //1 Second
        {name: "preSmeltMetal", delay: 8 * 1000, tag: "internal"}, //8 Seconds
        {name: "manageBotItemsDistribution", delay: 15 * 60 * 1000, tag: "internal"}, //15 Minutes
        {name: "cleanBuggedReservations_WhyDoIEvenHaveToPutSomethingLikeThis", delay: 15 * 60 * 1000, tag: "global"} //15 Minutes
    ]);
    /**
     * @type {AjaxResponses}
     */
    this.responses = new AjaxResponses(this);
    /**
     * @type {Users}
     */
    this.users = new Users(this);
    this.shop = new Shop(this);
    this.botsController = new BotsController(this);
    this.stats = new Stats(this);
    this.status = new TradeStatus(this);

    this.activeTrades = [];
    this.shopTrade_decay = 10000;

    this.botPorting = new BotPorting(this);

    events.EventEmitter.call(this);
    this.init();
}

require("util").inherits(Sfuminator, events.EventEmitter);

/**
 * Init shop, interrupts, active trades, stats<br>
 * Executed when instancing a new Sfuminator
 * @returns {undefined}
 */
Sfuminator.prototype.init = function () {
    var self = this;
    this.shop.on("ready", function () {
        self.log.debug("Shop is ready");
        self.interrupts.startInternals();
        self.interrupts.startGlobals();
        self.bindInterrupts();
        self.log.debug("Loading active trades");
        self.loadActiveTrades(function () {
            self.log.debug("-- Sfuminator socket is ready --", 0);
            self.emit("ready");
            self.stats.load();
        });
    });


};

/**
 * Assign actions to execute when interrupts are fired
 */
Sfuminator.prototype.bindInterrupts = function () {
    var self = this;
    this.interrupts.on("updatePrices", function () {
        self.shop.tf2Currency.update();
        self.shop.ratio.updateHats();
    });
    this.interrupts.on("updateKeyPrice", function () {
        try {
            self.webApi.getKeyPrice(function () {
                var myPrice = self.webApi.keyPricer.get();
                self.log.debug("Key price: " + myPrice.toMetal() + "ref or scrap: " + myPrice.toScrap() + " well keys.. " + myPrice.toKeys());
            });
        } catch (e) {
            self.log.error("Key pricing procedure is not working anymore. Most likely HTML has been changed somewhere... " + e);
        }
    });
    this.interrupts.on("updateTF2Data", function () {
        self.webApi.tf2.update();
    });
    this.interrupts.on("updateStats", function () {
        self.stats.update();
    });
    this.interrupts.on("updateShopInventory", function () {
        self.shop.inventory.update();
    });
    this.interrupts.on("updateTradeStatus", function () {
        self.status.update();
    });
    this.interrupts.on("updateActiveTrades", function () {
        self.updateActiveTrades();
    });
    this.interrupts.on("cleanBuggedReservations_WhyDoIEvenHaveToPutSomethingLikeThis", function () {
        self._cleanBuggedReservations();
    });
    this.interrupts.on("preSmeltMetal", function () {
        self.botsController.preSmeltMetal();
    });
    this.interrupts.on("manageBotItemsDistribution", function () {
        self.botsController.manageItemsDistribution();
    });
};

/**
 * Check if given steamid is an admin
 * @param {String} steamid
 * @returns {Boolean}
 */
Sfuminator.prototype.isAdmin = function (steamid) {
    for (var i = 0; i < this.admins.length; i += 1) {
        if (this.admins[i] === steamid) {
            return true;
        }
    }
    return false;
};

/**
 * Load currently active trades
 * @param {Function} callback Will be executed on trades loaded, no data is passed
 */
Sfuminator.prototype.loadActiveTrades = function (callback) {
    var self = this;
    var tryCallbackCount = 0;
    var tradeCount = 0;
    var tryCallback = function () {
        tryCallbackCount += 1;
        if (tradeCount === tryCallbackCount) {
            callback();
        }
    };
    this.shop.getActiveTrades(function (active_trades) {
        tradeCount = active_trades.length;
        if (tradeCount === 0) {
            callback();
        } else {
            for (var i = 0; i < active_trades.length; i += 1) {
                var shopTrade = self.users.get(active_trades[i].partnerID).makeShopTrade();
                shopTrade.setID(active_trades[i].id);
                shopTrade.load(function () {
                    tryCallback();
                });
            }
        }
    });
};

/**
 * Will update currently active trades
 * @param {Function} [callback] If given will be executed on update done,
 * active trades are passed.
 */
Sfuminator.prototype.updateActiveTrades = function (callback) {
    var self = this;
    var newActiveTrades = [];
    this.shop.getActiveTrades(function (active_trades) {
        for (var i = 0; i < active_trades.length; i += 1) {
            var shopTrade = self.users.get(active_trades[i].partnerID).getShopTrade();
            if (shopTrade && shopTrade.getID() === active_trades[i].id) {
                newActiveTrades.push(shopTrade);
            } else {
                self.log.error("Can't update active trade " + active_trades[i].id + ": id mismatch (local shop trade id for associated user is " + shopTrade.getID() + ")");
            }
        }
        self.activeTrades = newActiveTrades;
        if (typeof callback === "function") {
            callback(newActiveTrades);
        }
    });
};

/**
 * Execute on incoming request
 * @param {SfuminatorRequest} request
 * @param {Function} callback Response object will be passed
 */
Sfuminator.prototype.onRequest = function (request, callback) {
    var self = this;
    this.log.debug("Processing sfuminator request", 3);
    if (request.isValid() && request.getAction()) {
        this.log.debug("Sfuminator request is valid", 3);
        request.parseRequester(this.users, function () {
            self.onAction(request, callback);
        });
    } else {
        callback(false);
    }
};

/**
 * Execute on incoming action
 * @param {SfuminatorRequest} request
 * @param {Function} callback Response object will be passed
 */
Sfuminator.prototype.onAction = function (request, callback) {
    /** OLD BOT PORTING **/
    if (this.botPorting.requestAvailable(request)) {
        this.botPorting.onRequest(request, callback);
        return;
    }
    ///////////////////////
    var data = request.getData();
    var requester = request.getRequester();
    switch (request.getAction()) {
        case "fetchShopInventory": //Ajax request fired from shop
            this.fetchShopInventory(request, callback);
            break;
        case "updateShop":
            if (requester.privilege === "user") {
                callback(this.getUpdates(request));
            } else {
                callback(this.responses.notLogged);
            }
            break;
        case "requestTradeOffer":
        case "requestManualTrade":
            if (requester.privilege === "user") {
                this.requestTrade(request, ((request.getAction() === "requestTradeOffer") ? "offer" : "manual"), callback);
            } else {
                callback(this.responses.notLogged);
            }
            break;
        case "cancelTrade":
            if (requester.privilege === "user") {
                this.cancelTrade(request, callback);
            } else {
                callback(this.responses.notLogged);
            }
            break;
        case "searchItem":
            this.shop.search.saveRequest(request);
            callback(this.shop.search.find(request.getData().text));
            break;
        case "getShopItem":
            callback(this.shop.getItem(parseInt(data.id)).valueOf());
            break;
        case "getStats":
            callback(this.stats.get(parseInt(data.last_update_date)));
            break;
        case "verifyTradeUrlToken":
            this.clientCheckTradeOfferToken(request.getRequesterSteamid(), data.token, callback);
            break;
        case "i_ve_been_here":
            var justForValve = new Valve(request);
            justForValve.process(callback);
            break;
        default:
            callback(this.responses.methodNotRecognised);
    }
};

/**
 * Fetch client shop inventory
 * @param {SfuminatorRequest} request
 * @param {Function} callback Response object will be passed
 */
Sfuminator.prototype.fetchShopInventory = function (request, callback) {
    var data = request.getData();
    var self = this;
    switch (data.type) {
        case "mine":
            if (request.getRequester().privilege === "user") {
                var steamid = request.getRequester().id;
                var user = this.users.get(steamid);
                user.tf2Backpack.getCached(function (backpack) {
                    callback(self.shop.makeMine(backpack));
                });
            } else {
                callback(this.responses.notLogged);
            }
            break;
        default:
            if (this.shop.sectionExist(data.type)) {
                if (this.shop.sectionHasItems(data.type)) {
                    callback(this.shop.getClientBackpack(data.type));
                } else {
                    callback(this.responses.sectionHasNoItems);
                }
            } else {
                callback(this.responses.sectionNotFound);
            }
            break;
    }
};

/**
 * Get client formatted interface updates
 * @param {SfuminatorRequest} request
 * @returns {Response}
 */
Sfuminator.prototype.getUpdates = function (request) {
    var data = request.getData();
    var response = this.responses.make({update: true, methods: {}});
    var user = this.users.get(request.getRequesterSteamid());
    if (user.hasActiveShopTrade()) {
        var trade = user.getShopTrade();
        if (data.hasOwnProperty("trade") && data.trade === "aquired") {
            response.methods.updateTrade = trade.getClientChanges(data.last_update_date);
        } else if (!trade.isClosed()) {
            response.methods.startTrade = trade.valueOf();
        }
        if (trade.getMode() === "manual" && trade.getStatus() === "hold") {
            response.methods.setQueue = this.status.getQueue(user.getSteamid());
        }
    }
    if (data.hasOwnProperty("section") && data.section && this.shop.sectionHasItems(data.section.type)) { //Items
        var itemChanges = this.shop.sections[data.section.type].getClientChanges(data.section.last_update_date);
        if (itemChanges !== false) {
            response.methods.updateItemsVersioning = itemChanges;
        } else {
            response.methods.freshBackpack = this.shop.getClientBackpack(data.section.type);
        }
    }
    if (data.hasOwnProperty("section") && data.section.type === "mine" && !isNaN(data.section.last_update_date)) {
        if (user.getTF2Backpack().getLastUpdateDate() > new Date(data.section.last_update_date)) {
            response.methods.freshBackpack = this.shop.makeMine(user.getTF2Backpack());
        }
    }
    if (data.hasOwnProperty("last_reservation_date")) { //Reservations
        var reservationsChanges = this.shop.reservations.getClientChanges(data.last_reservation_date);
        if (reservationsChanges !== false) {
            response.methods.updateReservationsVersioning = reservationsChanges;
        } else {
            response.methods.freshReservations = this.shop.reservations.getClientList();
        }
    }
    response.compactUserUpdate();
    return response;
};

/**
 * Request shop trade
 * @param {SfuminatorRequest} request
 * @param {String} mode See ShopTrade._available_modes for more
 * @param {Function} callback Response object will be passed
 */
Sfuminator.prototype.requestTrade = function (request, mode, callback) {
    var self = this;
    var data = request.getData();
    if (!this.status.canTrade() && !this.isAdmin(request.getRequesterSteamid())) {
        callback(this.responses.cannotTrade(this.status.get()));
        return;
    }
    if (!data.hasOwnProperty("items") || (typeof data.items !== "object") || this.responses.make().isObjectEmpty(data.items) || !data.items) {
        callback(this.responses.noItems);
        return;
    }
    var user = this.users.get(request.getRequesterSteamid());
    if (!user.hasActiveShopTrade()) {
        var trade = user.makeShopTrade(data.items);
        trade.setMode(mode);
        trade.on("tradeRequestResponse", function (response) {
            self.log.debug("Request for trade rejected, response: " + trade.response.code);
            callback(response);
        });
        trade.verifyItems(function (success) {
            if (success) {
                if (self.botsController.assignBot(trade)) {
                    trade.consolidate(function () {
                        self.log.debug("Trade request approved (id: " + trade.getID() + " ~ " + user.getSteamid() + ")");
                        callback(self.responses.tradeRequestSuccess(trade));
                        self.botsController.startOffNewShopTrade(trade);
                    });
                } else {
                    self.log.error("Wasn't able to assign bot");
                    callback(self.responses.unableToAssignBot);
                }
            }
        });
    } else {
        if (user.getShopTrade().isClosed()) {
            callback(this.responses.shopTradeCooldown(user.getShopTrade().getLastUpdateDate()));
        } else {
            callback(this.responses.alreadyInTrade);
        }
    }
};

/**
 * Cancel shop trade
 * @param {SfuminatorRequest} request
 * @param {Function} callback Response object will be passed
 */
Sfuminator.prototype.cancelTrade = function (request, callback) {
    var user = this.users.get(request.getRequesterSteamid());
    if (user.hasShopTrade() && !user.getShopTrade().isClosed()) {
        user.getShopTrade().cancel();
        callback(this.responses.tradeCancelled);
    } else {
        callback(this.responses.notInTrade);
    }
};

Sfuminator.prototype.clientCheckTradeOfferToken = function (steamid, token, callback) {
    token = token.match(/[a-zA-Z0-9_-]*/i)[0]; //Prevent sneaky users
    var self = this;
    var user = this.users.get(steamid);
    if (user.getTradeToken() === token) {
        callback(self.responses.success);
    } else if (this.botsController.getUnrelatedAvailableBot(steamid)) {
        this.verifyTradeOfferToken(steamid, token, function (tokenToSave) {
            if (tokenToSave) {
                self.log.debug("Saving trade token " + tokenToSave + " for steamid " + steamid);
                callback(self.responses.success);
                self.users.get(steamid).setTradeToken(token);
            } else {
                callback(self.responses.wrongTradeToken);
            }
        });
    } else {
        callback(this.responses.cannotVerifyTradeToken);
    }
};

Sfuminator.prototype.verifyTradeOfferToken = function (steamid, token, callback) {
    var unrelatedBot = this.botsController.getUnrelatedAvailableBot(steamid);
    if (unrelatedBot) {
        function check() {
            unrelatedBot.steamClient.tradeOffersManager.getEscrowDuration(steamid, token, function (error) {
                if (error) {
                    callback(false);
                } else {
                    callback(token);
                }
            });
        }

        if (unrelatedBot.steamClient.isFriend(steamid)) {
            setTimeout(function () {
                //Be sure that bot gets unrelated also for steam
                //Friend removal may take some time, this procedure should grant 99.99% reliability.
                check();
            }, 4000);
        } else {
            check();
        }
    } else {
        callback(false);
    }
};

/**
 * @returns {CFG}
 */
Sfuminator.prototype.getCFG = function () {
    return CFG;
};

/**
 * @returns {BotsController}
 */
Sfuminator.prototype.getBotsController = function () {
    return this.botsController;
};

Sfuminator.prototype._cleanBuggedReservations = function () {
    var self = this;
    this.db.connect(function (connection) {
        connection.query("DELETE FROM `shop_reservations` WHERE `reservation_date`<'" + (new Date(Date.now() - ***REMOVED***000).toMysqlFormat()) + "'", function (result) {
            connection.release();
            self.log.debug("Boh.. io queste di un'ora fa le cancello " + result);
        });
    });
};