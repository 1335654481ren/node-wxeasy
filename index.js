'use strict';

var sha1 = require('sha1');
var request = require('request');
var xml2js = require('xml2js');

var Events = require('./api/events');
var config = require('./config');
var template = require('./template');

var WXeasy = Events.extend({

    init: function(config) {
        var self = this;

        this.config = config || {};
        this.app = this.config.app;
        this.appid = this.config.appid || '';
        this.appsecret = this.config.appsecret || '';
        this.token = this.config.token;
        this.API_URL = this.config.access_token_apiurl || '';

        this.end_time = 0;
        this.keep = false;

        if (self.API_URL) {
            setInterval(function () {
                self.keep = false;
            }, 300 * 1000);
        }

        this.access_token = '';
        this.start_access_token_time = 0;
        this._init();
    },

    _init: function() {
        var self = this;

        self.app.get('/verify', function(req, res) {
            self.checkSignature(req, res);
        });

        self.app.post('/verify', function(req, res) {
            self.res = res;
            var buf = '';
            req.setEncoding('utf8');
            req.on('data', function(chunk) {
                buf += chunk;
            });

            req.on('end', function() {
                xml2js.parseString(buf, function(err, json) {
                    if (err) {
                        err.status = 400;
                    } else {
                        self.parse(json.xml);
                    }
                });
            });
        });
    },

    /**
     * @method checkSignature
     * 验证消息真实性
     */
    checkSignature: function(req, res) {
        var query = req.query;
        var signature = query.signature;
        var echostr = query.echostr;
        var timestamp = query.timestamp;
        var nonce = query.nonce;

        // 1. 将token、timestamp、nonce三个参数进行字典序排序
        var arr = [this.token, timestamp, nonce];
        arr.sort();
        // 2. 将三个参数字符串拼接成一个字符串进行sha1加密
        var str = sha1(arr.join(""));
        // 3. 开发者获得加密后的字符串可与signature对比，标识该请求来源于微信
        if (str == signature) {
            res.status(200).send(echostr);
        } else {
            res.status(200).send('fail');
        }
    },

    r: function(err, resp, body, callback) {
        if (!err && resp.statusCode == 200) {
            callback(JSON.parse(body));
        }
    },

    getUrl: function(url, next) {
        var self = this;

        self.getAccessToken(function (data) {
            self.access_token = data.access_token;
            if (data.end_time) self.end_time = parseFloat(data.end_time);
            next && next(url + '?access_token=' + data.access_token);
        });
    },

    // get request
    getRequest: function(url, callback) {
        var self = this;
        request(url, function(err, resp, body) {
            self.r(err, resp, body, callback);
        });
    },

    // post request
    postRequest: function(url, body, callback) {
        callback = callback || function() {
            console.log('postRequest default callback invoked');
        };
        var self = this;
        var options = {
            url: url,
            method: 'post',
            body: JSON.stringify(body)
        };
        console.log('========== postRequest ==========');
        console.log(options);
        request(options, function(err, resp, body) {
            self.r(err, resp, body, callback);
        });
    },

    /**
     * @method getAccessToken
     * 从微信服务器获取一个新的access_token
     */
    getAccessToken: function(callback) {
        var self = this;

        if (self.API_URL) {
            if ((self.end_time - new Date().getTime()) < 300*1000) {//超时重新获得
                self.keep = false;

                request(self.API_URL, function(err, resp, body) {
                    if (err || resp.statusCode != 200) {
                        //接口失败，直接走微信
                        var url = config.GET_ACCESS_TOKEN + "?grant_type=client_credential&appid=" + self.appid + "&secret=" + self.appsecret;
                        self.getRequest(url, callback);
                    } else if (!err && resp.statusCode == 200) {
                        callback(JSON.parse(body));
                    }
                });
            } else {
                if (self.keep) {
                    callback && callback({access_token: self.access_token});
                    return;
                }
                request(self.API_URL, function(err, resp, body) {
                    if (!err && resp.statusCode == 200) {
                        var d = JSON.parse(body);

                        if (d.access_token == self.access_token) {
                            self.keep = true;
                        } else {
                            self.access_token = d.access_token;
                        }
                        callback(d);
                    }
                });
            }
        } else {
            //直接走微信
            var url = config.GET_ACCESS_TOKEN + "?grant_type=client_credential&appid=" + self.appid + "&secret=" + self.appsecret;
            self.getRequest(url, callback);
        }
    },

    /**
     * @method getWeixinIPList
     * 获取微信服务器IP地址
     */
    getWeixinIPList: function(callback) {
        var self = this;

        self.getUrl(config.GET_WEIXIN_IP_LIST, function (url) {
            self.getRequest(url, callback);
        });
    },

    parse: function(data) {
        var msgType = data.MsgType[0] ? data.MsgType[0] : 'text';
        switch (msgType) {
            case 'text':
            case 'image':
            case 'voice':
            case 'video':
            case 'shortvideo':
            case 'location':
            case 'link':
                this.parseNormalMsg(data);
                break;
            case 'event':
                this.parseEventMsg(data);
                break;
            default:
                break;
        }
    },

    // 接收普通消息
    // 1 文本消息 2 图片消息 3 语音消息 4 视频消息 5 小视频消息 6 地理位置消息 7 链接消息
    parseNormalMsg: function(data) {
        var msg = {};
        for (var i in data) {
            msg[i.slice(0, 1).toLowerCase() + i.slice(1)] = data[i][0];
        }
        this.trigger('allMsg', msg);
        this.trigger(msg.msgType + 'Msg', msg);
    },

    // 接收事件推送
    // 1 关注/取消关注事件 2 扫描带参数二维码事件 3 上报地理位置事件 4 自定义菜单事件 5 点击菜单拉取消息时的事件推送 6 点击菜单跳转链接时的事件推送
    // 1 subscribeEventMsg unsubscribeEventMsg 2 3 LOCATIONEventMsg
    parseEventMsg: function(data) {
        var msg = {};
        for (var i in data) {
            msg[i.slice(0, 1).toLowerCase() + i.slice(1)] = data[i][0];
        }
        this.trigger('allEventMsg', msg);
        this.trigger(msg.event + 'EventMsg', msg);
    },

    /************************************************************
     * 发送消息
     *     发送被动回复消息
     *     客服接口
     *     高级群发接口
     *     模板消息接口
     *     获取自动回复规则
     ************************************************************/
    // 发送被动回复消息
    sendMsg: function(msg) {
        var self = this;

        var msgType = msg.msgType;
        var out = template[msgType](msg);
        //console.log(out);
        self.res.type('xml');
        return self.res.send(out);
    },

    sendTextMsg: function(msg) {
        msg.msgType = 'text';
        return this.sendMsg(msg);
    },

    sendImageMsg: function(msg) {
        msg.msgType = 'image';
        this.sendMsg(msg);
    },

    sendVoiceMsg: function(msg) {
        msg.msgType = 'voice';
        this.sendMsg(msg);
    },

    sendVideoMsg: function(msg) {
        msg.msgType = 'video';
        this.sendMsg(msg);
    },

    sendMusicMsg: function(msg) {
        msg.msgType = 'music';
        this.sendMsg(msg);
    },

    sendNewsMsg: function(msg) {
        msg.msgType = 'news';
        this.sendMsg(msg);
    },

    // 客服接口
    // 添加客服帐号
    addKFAccount: function(data, callback) {
        var self = this;

        self.getUrl(config.ADD_KFACCOUNT, function(url) {
        	self.postRequest(url, data, callback);
        });
    },

    // 获取所有客服账号
    getKFList: function(callback) {
        var self = this;

        self.getUrl(config.GET_KF_LIST, function(url) {
        	self.getRequest(url, callback);
        });
    },
    /**
     * 发送客户消息，主动消息 48小时内互动有效
     * @param msg
     * @param callback
     */
    sendCustomMsg: function(msg, callback) {
        var self = this;
        callback = callback || function(data) {
            console.log('>>> sendCustomMsg >>> default callback function invoked.');
            console.log(data);
        };

        self.getUrl(config.POST_CUSTOM_MESSAGE, function (url) {
            var options = {
                url: url,
                method: 'post',
                body: JSON.stringify(msg)
            };
            request(options, function(err, resp, body) {
                self.r(err, resp, body, callback);
            });
        });
    },

    /**
     * 发送模板消息
     * @param msg
     * @param callback
     */
    sendTemplateMsg: function(msg, callback) {
        var self = this;
        callback = callback || function(data) {
            console.log('>>> sendTemplateMsg >>> default callback function invoked.');
            console.log(data);
        };

        self.getUrl(config.POST_TEMPLATE_MESSAGE, function (url) {
            var options = {
                url: url,
                method: 'post',
                body: JSON.stringify(msg)
            };

            request(options, function(err, resp, body) {
                self.r(err, resp, body, callback);
            });
        });
    },

    /**
     * @method getCurrentAutoReplyInfo
     * 获取自动回复规则
     */
    getCurrentAutoReplyInfo: function(callback) {
        var self = this;

        self.getUrl(config.GET_CURRENT_AUTOREPLY_INFO, function(url) {
        	self.getRequest(url, callback);
        });
    },



    /************************************************************
     * 自定义菜单
     * 自定义菜单查询接口
     * 自定义菜单删除接口
     * 自定义菜单创建接口
     * 获取自定义菜单配置接口
     ************************************************************/
    /**
     * @method getMenu
     * 自定义菜单查询接口
     */
    getMenu: function(callback) {
        var self = this;

        self.getUrl(config.GET_MENU, function(url) {
        	self.getRequest(url, callback);
        });
    },

    /**
     * @method deleteMenu
     * 自定义菜单删除接口
     */
    deleteMenu: function(callback) {
        var self = this;

        self.getUrl(config.DELETE_MENU, function(url) {
        	self.getRequest(url, callback);
        });
    },

    /**
     * @method createMenu
     * 自定义菜单创建接口
     */
    createMenu: function(menuObj, callback) {
        var self = this;

        this.getUrl(config.CREATE_MENU, function (url) {
            var options = {
                url: url,
                method: 'post',
                body: JSON.stringify(menuObj)
            };

            request(options, function(err, resp, body) {
                self.r(err, resp, body, callback);
            });
        });
    },

    /**
     * @method getCurrentSelfMenuInfo
     * 获取自定义菜单配置接口
     */
    getCurrentSelfMenuInfo: function(callback) {
    	var self = this;

        self.getUrl(config.GET_CURRENT_SELF_MENU_INFO, function(url) {
        	self.getRequest(url, callback);
        });
    },


    /************************************************************
     * 素材管理
     ************************************************************/

    /**
     * @method getMaterialCount
     * 获取素材总数
     */
    getMaterialCount: function(callback) {
        var self = this;

        self.getUrl(config.GET_MATERIAL_COUNT, function(url) {
        	self.getRequest(url, callback);
        });
    },

    /**
     * @method BATCH_GET_MATERIAL
     */
    batchGetMaterial: function(data, callback) {
        var self = this;

        self.getUrl(config.BATCH_GET_MATERIAL, function(url) {
        	self.postRequest(url, data, callback);
        });

    },


    /************************************************************
     * 账号管理
     ************************************************************/

    /**
     * @method createQrcode
     * 创建二维码ticket
     */
    createQrcode: function(data, callback) {
        var self = this;

        self.getUrl(config.CREATE_QRCODE, function(url) {
        	self.postRequest(url, data, callback);
        });
    },

    /**
     * @method getShortUrl
     * 长链接转短链接
     */
    getShortUrl: function(data, callback) {
        var self = this;

        self.getUrl(config.GET_SHORT_URL, function(url) {
        	this.postRequest(url, data, callback);
        });
    }
});

module.exports = WXeasy;
