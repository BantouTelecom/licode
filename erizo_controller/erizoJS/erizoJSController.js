/*global require, exports, , setInterval, clearInterval*/

var addon = require('./../../erizoAPI/build/Release/addon');
var logger = require('./../common/logger').logger;
var rpc = require('./../common/rpc');

// Logger
var log = logger.getLogger("ErizoJSController");

exports.ErizoJSController = function (spec) {
    "use strict";

    var that = {},
        // {id: {subsId1: wrtc1, subsId2: wrtc2}}
        subscribers = {},
        // {id: {muxer: OneToManyProcessor, wrtc: WebRtcConnection}
        publishers = {},

        // {id: ExternalOutput}
        externalOutputs = {},

        INTERVAL_TIME_SDP = 100,
        INTERVAL_TIME_FIR = 100,
        INTERVAL_TIME_KILL = 30*60*1000, // Timeout to kill itself after a timeout since the publisher leaves room.
        waitForFIR,
        initWebRtcConnection,
        getSdp,
        getRoap;


    var CONN_INITIAL = 101, CONN_STARTED = 102, CONN_READY = 103, CONN_FINISHED = 104, CONN_CANDIDATE = 201, CONN_SDP = 202, CONN_FAILED = 500;


    /*
     * Given a WebRtcConnection waits for the state READY for ask it to send a FIR packet to its publisher. 
     */
    waitForFIR = function (wrtc, to) {

        if (publishers[to] !== undefined) {
            var intervarId = setInterval(function () {
              if (publishers[to]!==undefined){
                if (wrtc.getCurrentState() >= CONN_READY && publishers[to].muxer.getPublisherState() >=CONN_READY) {
                    log.info("Sending FIR");
                    publishers[to].muxer.sendFIR();
                    clearInterval(intervarId);
                }
              }

            }, INTERVAL_TIME_FIR);
        }
    };

    /*
     * Given a WebRtcConnection waits for the state CANDIDATES_GATHERED for set remote SDP. 
     */
    initWebRtcConnection = function (wrtc, callback, id_pub, id_sub, context) {

        if (GLOBAL.config.erizoController.sendStats) {
            wrtc.getStats(function (newStats){
                rpc.callRpc('stats_handler', 'stats', {pub: id_pub, subs: id_sub, stats: JSON.parse(newStats)});
            });
        }

        wrtc.init( function (newStatus, mess){
          log.info("webrtc Addon status", newStatus, mess);
          
          // if (newStatus === 102 && !sdpDelivered) {
          //   localSdp = wrtc.getLocalSdp();
          //   answer = getRoap(localSdp, roap);
          //   callback('callback', answer);
          //   sdpDelivered = true;

          // }
          // if (newStatus === 103) {
          //   callback('onReady');
          // }

          if (newStatus == CONN_INITIAL) {
            callback('callback', {type: 'started'});
            
          } else if (newStatus == CONN_SDP) {
            log.debug('Sending SDP', mess);
            if (context === undefined) {
                callback('callback', {type: 'answer', sdp: mess});
            }

          } else if (newStatus == CONN_CANDIDATE) {
            callback('callback', {type: 'candidate', candidate: mess});
            if (context !== undefined && context.candidates_sent === false) {
                log.debug("Setting remote candidates", context.candidates);
                for (var cand_idx in context.candidates) {
                    var candidate = context.candidates[cand_idx];
                    log.debug('Setting candidate ', cand_idx, candidate);
                    wrtc.addRemoteCandidate(candidate.sdpMid, candidate.candidate);
                }
                log.debug("Set");
                context.candidates_sent = true;
            }
          } else if (newStatus == CONN_STARTED) {
          }

        });
        log.info("initializing");

        if (context !== undefined) {
            log.debug("Setting context");
            wrtc.setRemoteSdp(context.sdp);
            wrtc.setSrtpSession(context.srtp_session);
            log.debug("Set");
            context.candidates_sent = false;
        }

        callback('callback', {type: 'initializing'});

        // var roap = sdp,
        //     remoteSdp = getSdp(roap);
        // wrtc.setRemoteSdp(remoteSdp);

        // var sdpDelivered = false;
    };

    /*
     * Gets SDP from roap message.
     */
    getSdp = function (roap) {

        var reg1 = new RegExp(/^.*sdp\":\"(.*)\",.*$/),
            sdp = roap.match(reg1)[1],
            reg2 = new RegExp(/\\r\\n/g);

        sdp = sdp.replace(reg2, '\n');

        return sdp;

    };

    /*
     * Gets roap message from SDP.
     */
    getRoap = function (sdp, offerRoap) {

        var reg1 = new RegExp(/\n/g),
            offererSessionId = offerRoap.match(/("offererSessionId":)(.+?)(,)/)[0],
            answererSessionId = "106",
            answer = ('\n{\n \"messageType\":\"ANSWER\",\n');

        sdp = sdp.replace(reg1, '\\r\\n');

        //var reg2 = new RegExp(/^.*offererSessionId\":(...).*$/);
        //var offererSessionId = offerRoap.match(reg2)[1];

        answer += ' \"sdp\":\"' + sdp + '\",\n';
        //answer += ' \"offererSessionId\":' + offererSessionId + ',\n';
        answer += ' ' + offererSessionId + '\n';
        answer += ' \"answererSessionId\":' + answererSessionId + ',\n \"seq\" : 1\n}\n';

        return answer;
    };

    that.getSrtpSession = function(streamId, peerId, callback) {
        log.debug("Getting SRTP Session from ", streamId, peerId);
        var session = undefined;
        if (peerId === null) {
            if (publishers[streamId] !== undefined) {
                log.debug("Obtaining from publisher");
                session = publishers[streamId].wrtc.getSrtpSession();
            }    
        } else {
            if (subscribers[streamId][peerId]) {
                log.debug("Obtaining from subscriber");
                session = publishers[streamId].wrtc.getSrtpSession();
            }
        }
        log.debug("Session", session);
        callback("callback", session);
    };

    that.setSrtpSession = function(srtpSession, streamId, peerId) {
        if (peerId === undefined) {
            if (publishers[streamId] !== undefined) {
                return publishers[streamId].wrtc.setSrtpSession(srtpSession);
            }    
        } else {
            if (subscribers[streamId][peerId]) {
                subscribers[streamId][peerId].setSrtpSession(srtpSession);
            }
        }
        return;
    };

    that.addExternalInput = function (from, url, callback) {

        if (publishers[from] === undefined) {

            log.info("Adding external input peer_id ", from);

            var muxer = new addon.OneToManyProcessor(),
                ei = new addon.ExternalInput(url);

            publishers[from] = {muxer: muxer};
            subscribers[from] = {};

            ei.setAudioReceiver(muxer);
            ei.setVideoReceiver(muxer);
            muxer.setExternalPublisher(ei);

            var answer = ei.init();

            if (answer >= 0) {
                callback('callback', 'success');
            } else {
                callback('callback', answer);
            }

        } else {
            log.info("Publisher already set for", from);
        }
    };

    that.addExternalOutput = function (to, url) {
        if (publishers[to] !== undefined) {
            log.info("Adding ExternalOutput to " + to + " url " + url);
            var externalOutput = new addon.ExternalOutput(url);
            externalOutput.init();
            publishers[to].muxer.addExternalOutput(externalOutput, url);
            externalOutputs[url] = externalOutput;
        }
    };

    that.removeExternalOutput = function (to, url) {
      if (externalOutputs[url] !== undefined && publishers[to]!=undefined) {
        log.info("Stopping ExternalOutput: url " + url);
        publishers[to].removeSubscriber(url);
        delete externalOutputs[url];
      }
    };

    that.processSignaling = function (streamId, peerId, msg) {
        log.info("Process Signaling message: ", streamId, peerId, msg);
        if (publishers[streamId] !== undefined) {

            if (subscribers[streamId][peerId]) {
                if (msg.type === 'offer') {
                    subscribers[streamId][peerId].setRemoteSdp(msg.sdp);
                } else if (msg.type === 'candidate') {
                    subscribers[streamId][peerId].addRemoteCandidate(msg.candidate.sdpMid, msg.candidate.candidate);
                } 
            } else {
                if (msg.type === 'offer') {
                    publishers[streamId].wrtc.setRemoteSdp(msg.sdp);
                } else if (msg.type === 'candidate') {
                    publishers[streamId].wrtc.addRemoteCandidate(msg.candidate.sdpMid, msg.candidate.candidate);
                } 
            }
            
        }
    };

    /*
     * Adds a publisher to the room. This creates a new OneToManyProcessor
     * and a new WebRtcConnection. This WebRtcConnection will be the publisher
     * of the OneToManyProcessor.
     */
    that.movePublisher = function (from, context, callback) {

        if (publishers[from] === undefined) {

            log.info("Adding publisher peer_id ", from);

            var muxer = new addon.OneToManyProcessor(),
                wrtc = new addon.WebRtcConnection(true, true, GLOBAL.config.erizo.stunserver, GLOBAL.config.erizo.stunport, GLOBAL.config.erizo.minport, GLOBAL.config.erizo.maxport);

            publishers[from] = {muxer: muxer, wrtc: wrtc, context: context};
            subscribers[from] = {};

            wrtc.setAudioReceiver(muxer);
            wrtc.setVideoReceiver(muxer);
            muxer.setPublisher(wrtc);

            initWebRtcConnection(wrtc, callback, from, undefined, context);

            //log.info('Publishers: ', publishers);
            //log.info('Subscribers: ', subscribers);

        } else {
            log.info("Publisher already set for", from);
        }
    };

    /*
     * Adds a publisher to the room. This creates a new OneToManyProcessor
     * and a new WebRtcConnection. This WebRtcConnection will be the publisher
     * of the OneToManyProcessor.
     */
    that.addPublisher = function (from, callback) {

        if (publishers[from] === undefined) {

            log.info("Adding publisher peer_id ", from);

            var muxer = new addon.OneToManyProcessor(),
                wrtc = new addon.WebRtcConnection(true, true, GLOBAL.config.erizo.stunserver, GLOBAL.config.erizo.stunport, GLOBAL.config.erizo.minport, GLOBAL.config.erizo.maxport);

            publishers[from] = {muxer: muxer, wrtc: wrtc};
            subscribers[from] = {};

            wrtc.setAudioReceiver(muxer);
            wrtc.setVideoReceiver(muxer);
            muxer.setPublisher(wrtc);

            initWebRtcConnection(wrtc, callback, from);

            //log.info('Publishers: ', publishers);
            //log.info('Subscribers: ', subscribers);

        } else {
            log.info("Publisher already set for", from);
        }
    };

    /*
     * Adds a subscriber to the room. This creates a new WebRtcConnection.
     * This WebRtcConnection will be added to the subscribers list of the
     * OneToManyProcessor.
     */
    that.addSubscriber = function (from, to, audio, video, callback) {

        if (publishers[to] !== undefined && subscribers[to][from] === undefined) {

            log.info("Adding subscriber from ", from, 'to ', to, 'audio', audio, 'video', video);

            var wrtc = new addon.WebRtcConnection(audio, video, GLOBAL.config.erizo.stunserver, GLOBAL.config.erizo.stunport, GLOBAL.config.erizo.minport, GLOBAL.config.erizo.maxport);

            subscribers[to][from] = wrtc;
            publishers[to].muxer.addSubscriber(wrtc, from);

            initWebRtcConnection(wrtc, callback, to, from);
            waitForFIR(wrtc, to);

            //log.info('Publishers: ', publishers);
            //log.info('Subscribers: ', subscribers);
        }
    };

    /*
     * Removes a publisher from the room. This also deletes the associated OneToManyProcessor.
     */
    that.removePublisher = function (from) {

        if (subscribers[from] !== undefined && publishers[from] !== undefined) {
            log.info('Removing muxer', from);
            publishers[from].muxer.close();
            log.info('Removing subscribers', from);
            delete subscribers[from];
            log.info('Removing publisher', from);
            delete publishers[from];
            var count = 0;
            for (var k in publishers) {
                if (publishers.hasOwnProperty(k)) {
                   ++count;
                }
            }
            log.info("Publishers: ", count);
            if (count === 0)  {
                log.info('Removed all publishers. Killing process.');
                process.exit(0);
            }
        }
    };

    /*
     * Removes a subscriber from the room. This also removes it from the associated OneToManyProcessor.
     */
    that.removeSubscriber = function (from, to) {

        var index = subscribers[to].indexOf(from);
        if (index !== -1) {
            log.info('Removing subscriber ', from, 'to muxer ', to);
            publishers[to].removeSubscriber(from);
            subscribers[to].splice(index, 1);
        }
    };

    /*
     * Removes all the subscribers related with a client.
     */
    that.removeSubscriptions = function (from) {

        var key;

        log.info('Removing subscriptions of ', from);
        for (key in subscribers) {
            if (subscribers.hasOwnProperty(key)) {
                index = subscribers[key].indexOf(from);
                if (index !== -1) {
                    log.info('Removing subscriber ', from, 'to muxer ', key);
                    publishers[key].removeSubscriber(from);
                    subscribers[key].splice(index, 1);
                }
            }
        }
    };

    return that;
};
