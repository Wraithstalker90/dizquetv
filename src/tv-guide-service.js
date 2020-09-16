
const constants = require("./constants");
const  FALLBACK_ICON = "https://raw.githubusercontent.com/vexorain/dizquetv/main/resources/dizquetv.png";

class TVGuideService
{
    /****
     *
     **/
    constructor(xmltv, db) {
        this.cached = null;
        this.lastUpdate = 0;
        this.updateTime = 0;
        this.currentUpdate = -1;
        this.currentLimit = -1;
        this.currentChannels = null;
        this.throttleX = 0;
        this.doThrottle = false;
        this.xmltv = xmltv;
        this.db = db;
    }

    async get() {
        while (this.cached == null) {
            await _wait(100);
        }
        this.doThrottle = true;
        return this.cached;
    }

    prepareRefresh(inputChannels, limit) {
        let t = (new Date()).getTime();
        this.updateTime = t;
        this.updateLimit = t + limit;
        let channels = inputChannels;
        this.updateChannels = channels;
        return t;
    }

    async refresh(t) {
        while( this.lastUpdate < t) {
            if (this.currentUpdate == -1) {
                this.currentUpdate = this.updateTime;
                this.currentLimit = this.updateLimit;
                this.currentChannels = this.updateChannels;
                await this.buildIt();
            }
            await _wait(100);
        }
        return await this.get();
    }

    async makeAccumulated(channel) {
        if (typeof(channel.programs) === 'undefined') {
            throw Error( JSON.stringify(channel).slice(0,200) );
        }
        let n = channel.programs.length;
        let arr = new Array( channel.programs.length + 1);
        arr[0] = 0;
        for (let i = 0; i < n; i++) {
            arr[i+1] =  arr[i] + channel.programs[i].duration;
            await this._throttle();
        }
        return arr;
    }

    async getCurrentPlayingIndex(channel, t) {
        let s = (new Date(channel.startTime)).getTime();
        if (t < s) {
            //it's flex time
            return {
                index : -1,
                start : t,
                program : {
                    isOffline : true,
                    duration : s - t,
                }
            }
        } else {
            let accumulate = this.accumulateTable[ channel.number ];
            if (typeof(accumulate) === 'undefined') {
                throw Error(channel.number + " wasn't preprocesed correctly???!?");
            }
            let hi = channel.programs.length;
            let lo = 0;
            let d = (t - s) % (accumulate[channel.programs.length]);
            let epoch = t - d;
            while (lo + 1 < hi) {
                let ha = Math.floor( (lo + hi)  / 2 );
                if (accumulate[ha] > d) {
                    hi = ha;
                } else {
                    lo = ha;
                }
            }

            if (epoch + accumulate[lo+1] <= t) {
                throw Error("General algorithm error, completely unexpected");
            }
            await this._throttle();
            return {
                index: lo,
                start: epoch + accumulate[lo],
                program: channel.programs[lo],
            }
        }
    }

    async getChannelPlaying(channel, previousKnown, t, depth) {
        if (typeof(depth) === 'undefined') {
            depth = [];
        }
        let playing = {};
        if (
            (typeof(previousKnown) !== 'undefined')
             && (previousKnown.program.duration == channel.programs[previousKnown.index].duration )
             && (previousKnown.start + previousKnown.program.duration == t)
        ) {
            //turns out we know the index.
            let index = (previousKnown.index + 1) % channel.programs.length;
            playing = {
                index : index,
                program: channel.programs[index],
                start : t,
            }
        } else {
            playing = await this.getCurrentPlayingIndex(channel, t);
        }
        if ( playing.program.isOffline && playing.program.type === 'redirect') {
            let ch2 = playing.program.channel;
            
            if (depth.indexOf(ch2) != -1) {
                console.error("Redirrect loop found! Involved channels = " + JSON.stringify(depth) );
            } else {
                depth.push( channel.number );
                let channel2 = this.channelsByNumber[ch2];
                if (typeof(channel2) === 'undefined') {
                    console.error("Redirrect to an unknown channel found! Involved channels = " + JSON.stringify(depth) );
                } else {
                    let otherPlaying = await this.getChannelPlaying( channel2, undefined, t, depth );
                    let start = Math.max(playing.start, otherPlaying.start);
                    let duration = Math.min(
                        (playing.start + playing.program.duration) - start,
                        (otherPlaying.start + otherPlaying.program.duration) - start
                    );
                    let program2 = clone( otherPlaying.program );
                    program2.duration = duration;
                    playing = {
                        index: playing.index,
                        start : start,
                        program: program2,
                    }
                }
            }
        }
        return playing;
    }

    async getChannelPrograms(t0, t1, channel)  {
        if (typeof(channel) === 'undefined') {
            throw Error("Couldn't find channel?");
        }
        let result = {
            channel: makeChannelEntry(channel),
        };
        let programs = [];
        let x = await this.getChannelPlaying(channel, undefined, t0);
        if (x.program.duration == 0) throw Error("A " + channel.name + " " + JSON.stringify(x) );


        let push = async (x) => {
            await this._throttle();
            if (
                (programs.length > 0)
                && isProgramFlex(x.program)
                && (
                    (x.program.duration <= constants.TVGUIDE_MAXIMUM_PADDING_LENGTH_MS)
                    || isProgramFlex(programs[ programs.length - 1].program)
                )
            ) {
                //meld with previous
                let y = clone( programs[ programs.length - 1] );
                y.program.duration += x.program.duration;
                programs[ programs.length - 1] = y;
            } else if (isProgramFlex(x.program) ) {
                if (programs.length > 0) {
                    let y = programs[ programs.length - 1];
                    let a = y.start;
                    let b = a + y.program.duration;
                    let a2 = x.start;
                    if (b > a2) {
                        throw Error( [  "darn0", b, a2,  JSON.stringify(y) , JSON.stringify(x) ] );
                    }
                }

                programs.push( {
                    start: x.start,
                    program: {
                        isOffline : true,
                        duration: x.program.duration,
                    },
                } );
            } else {
                if (programs.length > 0) {
                    let y = programs[ programs.length - 1];
                    let a = y.start;
                    let b = a + y.program.duration;
                    let a2 = x.start;
                    if (b > a2) {
                        throw Error( [  "darn", b, a2,  JSON.stringify(y) , JSON.stringify(x) ] );
                    }
                }
                programs.push(x);
            }
        };
        while (x.start < t1) {
            await push(x);
            x = await this.getChannelPlaying(channel, x, x.start + x.program.duration);
            if (x.program.duration == 0) throw Error("D");
        }
        result.programs = [];
        for (let i = 0; i < programs.length; i++) {
            await this._throttle();
            if (isProgramFlex( programs[i].program) ) {
                let start = programs[i].start;
                let duration = programs[i].program.duration;
                if (start <= t0) {
                    const M = 5*60*1000;
                    let newStart = t0 - t0%M;
                    if (start < newStart) {
                        duration -= (newStart - start);
                        start = newStart;
                    }
                }
                while( start < t1 && duration > 0) {
                    let d = Math.min(duration, constants.TVGUIDE_MAXIMUM_FLEX_DURATION);
                    if (duration - constants.TVGUIDE_MAXIMUM_FLEX_DURATION <= constants.TVGUIDE_MAXIMUM_PADDING_LENGTH_MS) {
                        d = duration;
                    }
                    let x = {
                        start: start,
                        program: {
                            isOffline: true,
                            duration: d,
                        }
                    }
                    duration -= d;
                    start += d;
                    result.programs.push( makeEntry(channel,x) );
                }
            } else {
                if (i > 0) {
                    let y = programs[ i - 1];
                    let x = programs[i];
                    let a = y.start;
                    let b = a + y.program.duration;
                    let a2 = x.start;
                    if (b > a2) {
                        console.error( "darn2", b, a2 );
                    }

                }
                result.programs.push( makeEntry(channel, programs[i] ) );
            }
        }
         
        return result;
    }

    async buildItManaged() {
        let t0 = this.currentUpdate;
        let t1 = this.currentLimit;
        let channels = this.currentChannels;
        let accumulateTable = {};
        this.channelsByNumber = {};
        for (let i = 0; i < channels.length; i++) {
            this.channelsByNumber[ channels[i].number ] = channels[i];
            accumulateTable[ channels[i].number ] = await this.makeAccumulated(channels[i]);
        }
        this.accumulateTable = accumulateTable;
        let result = {};
        if (channels.length == 0) {
            let channel = {
                name: "dizqueTV",
                icon: FALLBACK_ICON,
            }
            result[1] = {
                channel : channel,
                programs: [
                    makeEntry(
                      channel
                      , {
                        start: t0 - t0 % (30 * 60*1000),
                        program: {
                            duration: 24*60*60*1000,
                            icon: FALLBACK_ICON,
                            showTitle: "No channels configured",
                            date: formatDateYYYYMMDD(new Date()),
                            summary : "Use the dizqueTV web UI to configure channels."
                        }
                      } )
                ]
            }
        } else {
            for (let i = 0; i < channels.length; i++) {
              if(! channels[i].stealth) {
                let programs = await this.getChannelPrograms(t0, t1, channels[i] );
                result[ channels[i].number ] = programs;
              }
            }
        }
        return result;
    }

    async buildIt() {
        try {
            this.cached = await this.buildItManaged();
            console.log("Internal TV Guide data refreshed at " + (new Date()).toLocaleString() );
            await this.refreshXML();
        } catch(err) {
            console.error("Unable to update internal guide data", err);
            await _wait(100);
            console.error("Retrying TV guide...");
            await this.buildIt();

        } finally {
            this.lastUpdate = this.currentUpdate;
            this.currentUpdate = -1;
        }
    }

    async _throttle() {
        //this.doThrottle = true;
        if ( this.doThrottle && (this.throttleX++)%10 == 0) {
            await _wait(0);
        }
    }

    async refreshXML() {
        let xmltvSettings = this.db['xmltv-settings'].find()[0];
        await this.xmltv.WriteXMLTV(this.cached, xmltvSettings, async() => await this._throttle() );
    }

    async getStatus() {
        await this.get();
        let channels =  [];

        Object.keys( this.cached )
            .forEach( (k,index) => channels.push(k) );

        return {
            lastUpdate : new Date(this.lastUpdate).toISOString(),
            channelNumbers: channels,
        }
    }

    async getChannelLineup(channelNumber, dateFrom, dateTo) {
        await this.get();
        let t0 = dateFrom.toISOString();
        let t1 = dateTo.toISOString();
        let channel = this.cached[channelNumber];
        if (typeof(channel) === undefined) {
            return null;
        }
        let programs = channel.programs;
        let result = {
            icon: channel.channel.icon,
            name: channel.channel.name,
            number: channel.channel.number,
            programs: [],
        };
        for (let i = 0; i < programs.length; i++) {
            let program = programs[i];
            let a;
            if (program.start > t0) {
                a = program.start;
            } else {
                a = t0;
            }
            let b;
            if (program.stop < t1) {
                b = program.stop;
            } else {
                b = t1;
            }

            if (a < b) {
                result.programs.push( program );
            }
        }
        return result;
    }
    
}


function _wait(t) {
    return new Promise((resolve) => {
      setTimeout(resolve, t);
    });
}




function isProgramFlex(program) {
    return program.isOffline || program.duration <= constants.STEALTH_DURATION
}

function clone(o) {
    return JSON.parse( JSON.stringify(o) );
}

function makeChannelEntry(channel) {
    return {
        name: channel.name,
        icon: channel.icon,
        number: channel.number,
    }
}

function makeEntry(channel, x) {
    let title = undefined;
    let icon = undefined;
    let sub = undefined;
    if (isProgramFlex(x.program)) {
        title = channel.name;
        icon = channel.icon;
    } else {
        title = x.program.showTitle;
        if (typeof(x.program.icon) !== 'undefined') {
            icon = x.program.icon;
        }
        if (x.program.type === 'episode') {
            sub = {
                season: x.program.season,
                episode: x.program.episode,
                title: x.program.title,
            }
        }
    }
    if (typeof(title)==='undefined') {
        title=".";
    }
    //what data is needed here?
    return {
        start: (new Date(x.start)).toISOString(),
        stop: (new Date(x.start + x.program.duration)).toISOString(),
        summary: x.program.summary,
        date: x.program.date,
        rating: x.program.rating,
        icon: icon,
        title: title,
        sub: sub,
    }
}

function formatDateYYYYMMDD(date) {
    var year = date.getFullYear().toString();
    var month = (date.getMonth() + 101).toString().substring(1);
    var day = (date.getDate() + 100).toString().substring(1);
    return year + "-" + month + "-" + day;
}

module.exports = TVGuideService