module.exports = function(RED) {
    'use strict'
    const moment = require('moment');
    const mqtt = require('./mqtt');

    const offValue = 'off';
    const noneValue = 'none';
    const boostValue = 'boost';
    const awayValue = 'away';

    RED.nodes.registerType('climate-zone', function(config) {
        RED.nodes.createNode(this, config);
        var node = this;

        // Internal State
        this.name = config.name || this.id;
        this.sendTopic = config.name ? `${config.name.toLowerCase().trim().replace(/\s+/g, '-')}` : `${this.id}`;
        this.deviceId = config.name ? `${config.name.toLowerCase().trim().replace(/\s+/g, '-')}-climate` : `${this.id}-climate`;
        this.sendStatus = config.sendStatus;
        this.outputs = config.outputs;
        this.updateTimeout = null;
        this.starting = true;

        // Configuration
        this.keepAliveMs = parseFloat(config.keepAlive) * 1000; //< seconds to ms
        this.cycleDelayMs = parseFloat(config.cycleDelay) * 1000; //< seconds to ms
        this.offTimeMs = parseFloat(config.offTime) * 1000 * 60; //< minutes to ms
        this.boostDurationMins = config.boostDuration;
        this.zoneWeight = parseFloat(config.zoneWeight);
        this.triggerZone = config.triggerZone;

        // Set Point
        this.degrees = config.degrees;
        this.defaultHeatSetPoint = parseFloat(config.defaultHeatSetPoint);
	this.defaultCoolSetPoint = parseFloat(config.defaultCoolSetPoint);
        this.deadband = parseFloat(config.deadband);
        this.tolerance = parseFloat(config.tolerance);
        this.minTemp = parseFloat(config.minTemp);
        this.maxTemp = parseFloat(config.maxTemp);
        this.tempValidMs = parseFloat(config.tempValid) * 1000 * 60; //< mins to ms
        this.swapDelayMs = parseFloat(config.swapDelay) * 1000 * 60; //< mins to ms
        
        // Outputs
        this.onPayload = config.onPayload;
        this.onPayloadType = config.onPayloadType;
        this.offPayload = config.offPayload;
        this.offPayloadType = config.offPayloadType;

        // Advertising
        this.advertise = config.advertise;
        this.broker = RED.nodes.getNode(config.broker);
        this.topic = config.topic ? `${config.topic.toLowerCase().trim('/')}/${this.deviceId}` : null;

        // Capabilities
        this.hasHeating = config.climateType === 'both' || config.climateType === 'heat' || config.climateType === 'manual';
        this.hasCooling = config.climateType === 'both' || config.climateType === 'cool' || config.climateType === 'manual';
        this.hasSetpoint = config.climateType !== 'manual';

        // Default mode when on value or boost is used
        this.defaultMode = 'heat';
        if (config.climateType === 'both') {
            this.defaultMode = 'heat_cool';
        } else if (config.climateType === 'cool') {
            this.defaultMode = 'cool';
        }

        // Previous state
        this.lastChange = null;
        this.lastTemp = null;
        this.lastHeatTime = null;
        this.lastHeatSetpoint = null;
        this.lastCoolTime = null;
        this.lastCoolSetpoint = null;
        this.lastSend = null;
        this.lastOffTime = moment();
        this.lastAction = null;
        this.lastMode = null;

        // Handle direct inputs
        this.on("input", function(msg, send, done) {
            if (msg.hasOwnProperty('payload')) { node.mode.set(msg.payload); }
            if (msg.hasOwnProperty('mode')) { node.mode.set(msg.mode); }
            if (msg.hasOwnProperty('preset')) { node.preset.set(msg.preset); }
            if (msg.hasOwnProperty('target_temperature')) {
                if (node.mode.get() === 'heat') {
                    node.setpoint_heat.set(msg.target_temperature);
                } else if (node.mode.get() === 'cool') {
                    node.setpoint_cool.set(msg.target_temperature);
                }
            }

            if (msg.hasOwnProperty('target_temperature_high')) { node.setpoint_cool.set(msg.target_temperature_high); updateSetpoint(); }
            if (msg.hasOwnProperty('target_temperature_low')) { node.setpoint_heat.set(msg.target_temperature_low); updateSetpoint(); }
            if (msg.hasOwnProperty('current_temperature')) { node.temp.set(msg.current_temperature); }

            // Backwards compatibility
            if (msg.hasOwnProperty('temp')) { node.temp.set(msg.temp); }
            //if (msg.hasOwnProperty('setpoint')) { node.setpoint.set(msg.setpoint); }
            if (msg.hasOwnProperty('setpoint')) {
                if (node.mode.get() === 'heat') {
                    node.setpoint_heat.set(msg.setpoint);
                } else if (node.mode.get() === 'cool') {
                    node.setpoint_cool.set(msg.setpoint);
                }
            }
            if (msg.hasOwnProperty('boost')) { node.preset.set(isOn(msg.boost) ? boostValue : noneValue); }
            if (msg.hasOwnProperty('away')) { node.preset.set(isOn(msg.away) ? awayValue : noneValue); }

            node.update();
            done();
        });

        // On node shutdown
        this.on('close', function(removed, done) {
            node.clearUpdateTimeout();
            if (node.mqtt) {
                node.mqtt.stop(done);
            } else {
                done();
            }
        });

        // On mqtt message
        this.onMqttSet = function (type, value) {
            if (type === 'mode') { node.mode.set(value); }
            if (type === 'preset') { node.preset.set(value); }
            //if (type === 'setpoint') { node.setpoint.set(value); }
            if (type === 'setpoint') {
                if (node.mode.get() === 'heat') {
                    node.setpoint_heat.set(value);
                } else if (node.mode.get() === 'cool') {
                    node.setpoint_cool.set(value);
                }
            }

            if (type === 'setpoint_heat') { node.setpoint_heat.set(value); updateSetpoint(); }
            if (type === 'setpoint_cool') { node.setpoint_cool.set(value); updateSetpoint(); }

            node.update();
        }

        // On mqtt advertise
        this.onMqttConnect = function() {
            let device = {
                identifiers: [ node.deviceId ],
                name: `${node.name} Climate`,
                model: 'Climate Zone',
                sw_version: '1.0',
                manufacturer: 'tek79'
            };

            let climate = {
                name: node.name,
                unique_id: node.deviceId,
                action_topic: `${node.topic}/action`,
                mode_state_topic: `${node.topic}/mode`,
                mode_command_topic: `${node.topic}/mode/set`,
                preset_mode_state_topic: `${node.topic}/preset`,
                preset_mode_command_topic: `${node.topic}/preset/set`,
                preset_modes: [ boostValue, awayValue ],
                modes: [ offValue ],
                device: device
            };

            // Add setpoint config
            if (node.hasSetpoint) {
                climate.temperature_state_topic = `${node.topic}/setpoint`; 
                climate.temperature_command_topic = `${node.topic}/setpoint/set`; 
                climate.current_temperature_topic = `${node.topic}/temp`; 
                climate.initialHeat = node.defaultHeatSetPoint;
		climate.initialCool = node.defaultCoolSetPoint;
                climate.max_temp = node.maxTemp;
                climate.min_temp = node.minTemp;
                //climate.temp_step = node.degrees === 'C' ? 0.5 : 1;
		climate.temp_step = 0.5;
                climate.temperature_unit = node.degrees;

                if (node.hasCooling && node.hasHeating) 
                    climate.modes.push('heat_cool');
            }

            // Add climate modes
            if (node.hasHeating) climate.modes.push('heat');
            if (node.hasCooling) climate.modes.push('cool');

            return [
                { type: 'climate', payload: climate }
            ];
        }

        // Get value from storage
        this.getValue = function(id) {
            return node.context().get(id);
        }

        // Get value in selected format
        this.getOutput = function(isOn) {

            let value = isOn ? node.onPayload : node.offPayload;
            let type = isOn ? node.onPayloadType : node.offPayloadType;

            if (value === undefined || value.length == 0 || type === undefined || type.length == 0) {
                value = isOn ? 'ON' : 'OFF';
                type = 'str';
            }

            switch (type) {
                case 'json':
                    value = JSON.parse(value);
                    break;
                case 'bool':
                    value = (value === "true");
                    break;
                case 'num':
                    value = parseFloat(value);
                    break;
            }

            return value;
        };

        // Set value for storage (mqtt)
        this.setValue = function(id, v, mv) {
            node.context().set(id, v);
            if (node.mqtt) node.mqtt.setValue(id, mv || v);
        }

        // Clear update
        this.clearUpdateTimeout = function() {
            if (node.updateTimeout) {
                clearTimeout(node.updateTimeout);
                node.updateTimeout = null;
            }
        }

        // Set status message and optionally send via output node
        this.setStatus = function(msg) {
            node.status(msg);
            if (node.sendStatus) {
                //node.send([ null, null, { topic: this.sendTopic, payload: msg }]);
            }
        }

        // Update the node status & send if needed
        this.updateStatus = function(s) {

            let ac = s.pending ? node.lastAction : s.action
            let col = ac === 'heating' ? 'yellow' : ac === 'cooling' ? 'blue' : 'grey';
            let pre = s.pending ? '* ' : ''
            let mode = s.preset === boostValue ? s.mode + '*' : s.mode;
            let msg = { fill: col, shape:'dot' };

            //if (s.mode === 'heat' || node.lastAction === 'heating') { s.setpoint = node.setpoint_heat.get(); }
            //if (s.mode === 'cool' || node.lastAction === 'cooling') { s.setpoint = node.setpoint_cool.get(); }

            if (s.mode === 'heat') { s.setpoint = node.setpoint_heat.get(); }
            if (s.mode === 'cool') { s.setpoint = node.setpoint_cool.get(); }
            if (s.mode === 'heat_cool') { s.setpoint = node.setpoint_heat.get() + '-' + node.setpoint_cool.get(); }

            if (s.action === 'idle') {
                msg.text = `${pre}waiting for temp...`;
            } else if (node.hasSetpoint) {
                let set = s.preset === awayValue ? 'away' : s.setpoint;
                msg.text = `${pre}mode=${mode}, set=${set}, temp=${s.temp}`;
            } else {
                msg.text = `${pre}mode=${mode}`;
            }

            // update on every input message
            node.status(msg);
        }

        this.calcSetpointAction = function(s, now) {
            // Waiting for input
            if (!s.tempTime || now.diff(s.tempTime) >= node.tempValidMs) {
                s.tempValid = false;
                s.pending = true;
                return 'idle';
            }

	    if (s.tempTime && now.diff(s.tempTime) < node.tempValidMs) {
                s.tempValid = true;
            }

            // if the mode is heat_cool and the current temperature is in the deadband, differential output = 0
            if (s.mode === 'heat_cool' && s.tempValid == true) { 
                if (s.temp < node.setpoint_heat.get()) { 
                    s.differentialTemp = parseFloat((s.temp - s.setpoint_heat).toFixed(1));
                } else if (s.temp > node.setpoint_cool.get()) { 
                    s.differentialTemp = parseFloat((s.temp - s.setpoint_cool).toFixed(1));
                } else {
                    s.differentialTemp = 0;
                }
            } else if (s.mode === 'heat' && s.tempValid == true) { 
                if (s.temp < node.setpoint_heat.get()) { 
                    s.differentialTemp = parseFloat((s.temp - s.setpoint_heat).toFixed(1));
                } else {
                    s.differentialTemp = 0;
                }
            } else if (s.mode === 'cool' && s.tempValid == true) { 
                if (s.temp > node.setpoint_cool.get()) { 
                    s.differentialTemp = parseFloat((s.temp - s.setpoint_cool).toFixed(1));
                } else {
                    s.differentialTemp = 0;
                }
            } else { 
                s.differentialTemp = 0;
            }

	    s.weight =  s.tempValid == true && s.mode != offValue ? node.zoneWeight : 0;
	    s.trigger = node.triggerZone;

            // Get Current Capability
            let canHeat = node.hasHeating && (s.mode === 'heat_cool' || s.mode === 'heat');
            let canCool = node.hasCooling && (s.mode === 'heat_cool' || s.mode === 'cool');

            if (node.lastAction === 'heating') { var heatPoint = s.setpoint_heat; } else { var heatPoint = (s.setpoint_heat - node.tolerance + 0.1); }			
            if (node.lastAction === 'cooling') { var coolPoint = s.setpoint_cool; } else { var coolPoint = (s.setpoint_cool + node.tolerance - 0.1); }

            if (canHeat && (s.temp < heatPoint)) {
                if ((!node.lastCoolTime || now.diff(node.lastCoolTime) >= node.swapDelayMs ) && (now.diff(node.lastOffTime) >= node.offTimeMs)) {
                    return 'heating';
                } else if ((now.diff(node.lastCoolTime) < node.swapDelayMs) || now.diff(node.lastOffTime) < node.offTimeMs) {
                    s.pending = true;
                }
            } else if (canCool && (s.temp > coolPoint)) {
                if ((!node.lastHeatTime || now.diff(node.lastHeatTime) >= node.swapDelayMs) && (now.diff(node.lastOffTime) >= node.offTimeMs)) {
                    return 'cooling';
                } else if ((now.diff(node.lastHeatTime) < node.swapDelayMs) || now.diff(node.lastOffTime) < node.offTimeMs) {
                    s.pending = true;
                }
            }

            return offValue;
        }

        // Update the current action
        this.update = function() {
            if (node.starting) {
                return;
            }

            node.clearUpdateTimeout();

            let now = moment();
            let presetExpiry = node.preset.expiry();
            let nextInterval = node.keepAliveMs;

            // End of preset time ?
            if (presetExpiry) {
                let diff = now.diff(presetExpiry);
                if (diff >= 0) {
                    node.preset.set(noneValue);
                } else if (nextInterval > 0) {
                    nextInterval = Math.min(nextInterval, -diff);
                }
            }

            // Current Status
            let s = {
                mode: node.mode.get(),
                modeChanged: false,
                preset: node.preset.get(),
                setpoint: node.setpoint.get(),
                setpoint_heat: node.setpoint_heat.get(),
                setpoint_cool: node.setpoint_cool.get(),
                setpointChanged: false,
                temp: node.temp.get(),
                tempChanged: false,
                tempTime: node.temp.time(),
                tempValid: false,
		differentialTemp: 0,
                action: offValue,
                heatOutput: node.heatOutput || false,
                coolOutput: node.coolOutput || false,
                changed: false,
                pending: false,
                keepAlive: false,
                sendMessage: false,
		weight: 0,
		trigger: false
            };

            // Use default mode for boosting
            if (s.preset === boostValue) {
                s.mode = node.defaultMode;
            }

            // Backwards compatibility
            s.boost = node.preset.get() === boostValue ? s.mode : offValue;

            // Calculate action when setpoint is active
            if (node.hasSetpoint) {
                s.action = node.calcSetpointAction(s, now);
                // for updateSetpoint function
                node.action = s.action;
            } else {
                // Manual set
                if (s.mode === 'heat') s.action = 'heating';
                else if (s.mode ===  'cool') s.action = 'cooling';
            }

            // Do nothing if away is active
            if (s.preset === awayValue) {
                s.action = offValue;
            }

            // Must be a keep alive or change to send message
            s.changed = s.action != node.lastAction;

            // Check if its time to keep alive
            if (node.lastSend && node.keepAliveMs > 0) {
                let diff = now.diff(node.lastSend);
                if (diff >= node.keepAliveMs) {
                    s.keepAlive = true;
                }
            }

            // Update status on temperature change
            if (s.temp != node.lastTemp) {
            s.changed = true;
            s.tempChanged = true;
            node.lastTemp = s.temp;
            }

            // Update status on setpoint change
            if (s.setpoint_heat != node.lastHeatSetpoint) {
            s.setpointChanged = true;
            node.lastHeatSetpoint = s.setpoint_heat;
            } else if (s.setpoint_cool != node.lastCoolSetpoint) {
            s.setpointChanged = true;
            node.lastCoolSetpoint = s.setpoint_cool;
            }

            // Update status on mode change
            if (s.mode != node.lastMode) {
            s.modeChanged = true;
            node.lastMode = s.mode;
            }

            s.sendMessage = (s.modeChanged || s.setpointChanged || s.tempChanged || s.keepAlive) ? true : false;

            // Heating / cooling states
            let heating = s.action === 'heating';
            let cooling = s.action === 'cooling';

	    // Update last heat/cool time
            if (heating || node.lastAction === 'heating') node.lastHeatTime = now;
            if (cooling || node.lastAction === 'cooling') node.lastCoolTime = now;

            // Don't allow changes faster than the cycle time to protect climate system
            if (s.changed) {
                let diff2 = now.diff(node.lastOffTime);
                if (diff2 < node.offTimeMs && (node.lastAction === 'off' || node.lastAction === 'idle' || node.lastAction === undefined)) {
                    s.pending = true;
                    //node.updateTimeout = setTimeout(node.update, node.OffTimeMs - diff2);
                    node.updateStatus(s);

                    // Keep sending status keepAlive updates during offDelay
                    if (s.sendMessage) {
                        var clonedMsg = RED.util.cloneMessage({ topic: this.sendTopic, status: s });
                        node.send([ null, null, clonedMsg ]);
                        node.lastSend = now;
                        // Send the stored states to the dedicated outputs to prevent them turning off during cycleDelay
                        node.send([ 
                            { topic: this.sendTopic, payload: node.heatOutput === true ? node.onPayload : node.offPayload }, 
                            { topic: this.sendTopic, payload: node.coolOutput === true ? node.onPayload : node.offPayload } 
                        ]);
                    }
                    return;
                }	
                if (node.lastChange) {
                    let diff = now.diff(node.lastChange);
                    // Only apply the cycle delay to a current heat or cool call, not a new call					
                    if (diff < node.cycleDelayMs && (node.lastAction === 'heating' || node.lastAction === 'cooling')) {
                        s.pending = true;
                        //node.updateTimeout = setTimeout(node.update, node.cycleDelayMs - diff);
                        node.updateStatus(s);

                        // Keep sending status keepAlive updates during cycleDelay
                        if (s.sendMessage) {
                            var clonedMsg = RED.util.cloneMessage({ topic: this.sendTopic, status: s });
                            node.send([ null, null, clonedMsg ]);
                            node.lastSend = now;
                            // Send the stored states to the dedicated outputs to prevent them turning off during cycleDelay
                            node.send([ 
                                { topic: this.sendTopic, payload: node.heatOutput === true ? node.onPayload : node.offPayload }, 
                                { topic: this.sendTopic, payload: node.coolOutput === true ? node.onPayload : node.offPayload } 
                            ]);
                        }
                        return;
                    }
                }				
		// Save lastOffTime when transitioning to off
		if ((node.lastAction === 'heating' || node.lastAction === 'cooling') && (s.action === 'off' || s.action === 'idle')) node.lastOffTime = now;

                // Store states for future checks
                node.lastChange = now;
                node.lastAction = s.action;
                // fix for swap delay setpoint updates
                if (node.lastAction === 'heating' || node.lastAction === 'cooling') node.lastHeatCool = node.lastAction;

                node.setValue('action', s.action);
            }

            // Send a message
            if (s.sendMessage || s.changed) {
                node.lastSend = now;
                node.send([ 
                    { topic: this.sendTopic, payload: node.getOutput(heating) }, 
                    { topic: this.sendTopic, payload: node.getOutput(cooling) } 
                ]);

                // Update status outputs
                s.heatOutput = node.getOutput(heating) === node.onPayload ? true : false;
                s.coolOutput = node.getOutput(cooling) === node.onPayload ? true : false;
                node.heatOutput = s.heatOutput;
                node.coolOutput = s.coolOutput;

                // Only send status at keepAlive intervals or changes
                if (node.sendStatus) {
                    var clonedMsg = RED.util.cloneMessage({ topic: this.sendTopic, status: s });
                    node.send([ null, null, clonedMsg ]);
                }
            }

            // Update status
            node.updateStatus(s);

            // Make sure update is called every so often
            if (nextInterval > 0) {
                // Adjust interval based on last change
                if (node.lastSend) {
                    let diff = now.diff(node.lastSend);
                    nextInterval = Math.max(nextInterval - diff, 1);
                }

                nextInterval = Math.min(node.tempValidMs, nextInterval);
                nextInterval = Math.max(1000, nextInterval);
                node.updateTimeout = setTimeout(function() { node.update() }, nextInterval);
            }
        }

        function isOn(v) {
            return v === 'on' || v === 'ON' || v === '1' || v === 1 || v === 'true' || v === 'TRUE' || v === true;
        }

        function isOff(v) {
            return v === 'off' || v === 'OFF' || v === '0' || v === 0 || v === 'false' || v === 'FALSE' || v === false;
        }

        // Update setpoint
        function updateSetpoint() {
            if (node.action === 'heating' || node.lastHeatCool === 'heating') node.setpoint.set(node.setpoint_heat.get());
            if (node.action === 'cooling' || node.lastHeatCool === 'cooling') node.setpoint.set(node.setpoint_cool.get());
        }

        // Mode
        function modeStore() {
            this.get = function() {
                let m = node.getValue('mode');
                return m === undefined ? offValue : m;
            };
            this.set = function(s) {
                if (s !== undefined) {
                    s = s.toString().toLowerCase();
                    if (isOn(s)) {
                        node.setValue('mode', node.defaultMode);
                    } else if (isOff(s)) {
                        node.setValue('mode', offValue);
                    } else if ((s === 'heat_cool' && node.hasSetpoint) || (s === 'heat' && node.hasHeating) || (s === 'cool' && node.hasCooling)) {
                        node.setValue('mode', s);
                    } 
                }
            };
        };

        // Preset
        function presetStore() {
            this.get = function() { 
                let b = node.getValue('preset');
                return b === undefined ? noneValue : b;
            };
            this.expiry = function() { 
                let t = node.context().get('presetExpiry'); 
                return t ? moment(t) : undefined;
            };
            this.set = function(s) {
                if (s !== undefined) {
                    s = s.toString().toLowerCase();
                    let before = this.get();

                    if (s === noneValue || isOff(s)) {
                        node.setValue('preset', noneValue);
                        node.setValue('presetExpiry', undefined);
                    } else if (s === boostValue) {
                        node.setValue('preset', boostValue);
                        if (this.get() != before) {
                            node.context().set('presetExpiry', moment().add(node.boostDurationMins,'minutes').valueOf());
                        }
                    } else if (s === awayValue) {
                        node.setValue('preset', awayValue);
                        node.setValue('presetExpiry', undefined);
                    }
                }
            };
        };

        // Setpoint
        function setpointStore() {
            this.get = function() { 
                let s = node.getValue('setpoint');
                return s === undefined ? node.defaultHeatSetPoint : s; 
            };
            this.set = function(s) {
                if (s && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        t = Math.min(Math.max(t, node.minTemp), node.maxTemp);
                        node.setValue('setpoint', t);
                    }
                }
            };
        };
		
	// Setpoint Heat
        function setpoint_heatStore() {
            this.get = function() { 
                let s = node.getValue('setpoint_heat');
                return s === undefined ? node.defaultHeatSetPoint : s; 
            };
            this.set = function(s) {
                if (s && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        t = Math.min(Math.max(t, node.minTemp), node.maxTemp - node.deadband);
                        node.setValue('setpoint_heat', t);
                        if (node.setpoint_cool.get() < t + node.deadband) node.setpoint_cool.set(t + node.deadband);
                    }
                }
            };
        };
		
	// Setpoint Cool
        function setpoint_coolStore() {
            this.get = function() { 
                let s = node.getValue('setpoint_cool');
                return s === undefined ? node.defaultCoolSetPoint : s; 
            };
            this.set = function(s) {
                if (s && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        t = Math.min(Math.max(t, node.minTemp + node.deadband), node.maxTemp);
                        node.setValue('setpoint_cool', t);
                        if (node.setpoint_heat.get() > t - node.deadband) node.setpoint_heat.set(t - node.deadband);
                    }
                }
            };
        };

        // Temp
        function tempStore() {
            this.get = function() { 
                let t = node.getValue('temp');
                return t;
            };
            this.time = function() { 
                let t = node.getValue('tempTime'); 
                return t ? moment(t) : undefined;
            };
            this.set = function(s) {
                if (s !== undefined && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        node.setValue('temp', t);
                        node.setValue('tempTime', moment().valueOf());
                    }
                }
            };
        };

        // Init Things
        node.mode = new modeStore();
        node.preset = new presetStore();
        node.setpoint = new setpointStore();
	node.setpoint_heat = new setpoint_heatStore();
	node.setpoint_cool = new setpoint_coolStore();
        node.temp = new tempStore();

        // If a broker is specified we create an mqtt handler
        if (node.broker && node.topic) {
            node.mqtt = new mqtt(node.deviceId, node.advertise, node.topic, node.broker, node.onMqttConnect, node.onMqttSet);
        }

        // Initial update
        node.setStatus({fill:'grey', shape:'dot', text:'starting...'});
        setTimeout(function() { 
            // startup init
            if (node.lastAction === undefined) node.lastAction = 'off';
            node.starting = false;
            node.update();
            node.lastChange = null;
            if (node.mqtt) {
                node.mqtt.setValue('mode', node.mode.get());
                node.mqtt.setValue('preset', node.preset.get());
                if (node.hasSetpoint) {
                    node.mqtt.setValue('setpoint', node.setpoint.get());
                    node.mqtt.setValue('temp', node.temp.get());
                }
            }
        }, 1000);
    });
}
