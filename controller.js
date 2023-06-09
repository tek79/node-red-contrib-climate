module.exports = function(RED) {
    'use strict'
    const moment = require('moment');
    const mqtt = require('./mqtt');

    const offValue = 'off';
    const noneValue = 'none';
    const boostValue = 'boost';
    const awayValue = 'away';

    RED.nodes.registerType('climate-controller', function(config) {
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
        this.boostDurationMins = config.boostDuration;
        this.offTimeMs = parseFloat(config.offTime) * 1000 * 60; //< minutes to ms

        // Set Point
        this.degrees = config.degrees;
        this.defaultSetPoint = 100;
        this.tolerance = parseFloat(config.tolerance);
        this.minTemp = parseFloat(config.minTemp);
        this.maxTemp = parseFloat(config.maxTemp);
        this.tempValidMs = parseFloat(config.tempValid) * 1000 * 60; //< mins to ms
        this.swapDelayMs = parseFloat(config.swapDelay) * 1000 * 60; //< mins to ms

        // Thresholds
        this.heatUpperWeight = config.heatUpperWeight;
        this.heatLowerWeight = config.heatLowerWeight;
        this.coolUpperWeight = config.coolUpperWeight;
        this.coolLowerWeight = config.coolLowerWeight;
		
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
        this.lastAction = null;
        this.lastHeatTime = null;
        this.lastCoolTime = null;
        this.lastSend = null;
        this.datTrip = 'expired';
        this.lastOffTime = moment();

        // Handle direct inputs
        this.on("input", function(msg, send, done) {

            if (msg.hasOwnProperty('mode')) { node.mode.set(msg.mode); }
            if (msg.hasOwnProperty('dat')) { node.dat.set(msg.dat); }

            if (msg.hasOwnProperty('status')) {
                node.temp.set(weightedDifferentialIn(msg.topic, msg.status.differentialTemp, msg.status.weight));
                this.weightTotal = parseFloat(zoneWeight(msg.topic, msg.status.weight));
                this.heatTriggerTotal = heatTriggerZones(msg.topic, msg.status.trigger, msg.status.heatOutput);
                this.heatWeightTotal = activeHeatWeight(msg.topic, msg.status.weight, msg.status.heatOutput);
                this.coolTriggerTotal = coolTriggerZones(msg.topic, msg.status.trigger, msg.status.coolOutput);
                this.coolWeightTotal = activeCoolWeight(msg.topic, msg.status.weight, msg.status.coolOutput);
            }	
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
            node.update();
        }

        // On mqtt advertise
        this.onMqttConnect = function() {
            let device = {
                identifiers: [ node.deviceId ],
                name: `${node.name} Climate Controller`,
                model: 'Climate Controller',
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
                climate.initial = node.defaultSetPoint;
                climate.max_temp = node.maxTemp;
                climate.min_temp = node.minTemp;
                climate.temp_step = node.degrees === 'C' ? 0.5 : 1;
                climate.temperature_unit = node.degrees;

                if (node.hasCooling && node.hasHeating) climate.modes.push('heat_cool');
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

        // Set status message
        this.setStatus = function(msg) {
            node.status(msg);
        }

        // Update the node status & send if needed
        this.updateStatus = function(s) {

            let ac = s.pending ? node.lastAction : s.action
            let col = ac === 'heating' ? 'yellow' : ac === 'cooling' ? 'blue' : 'grey';
            let pre = s.pending ? '* ' : ''
            let mode = s.preset === boostValue ? s.mode + '*' : s.mode;
            let msg = { fill: col, shape:'dot' };

            if (s.action == 'idle') {
                if (node.datTrip == false) {
                    msg.text = `${pre}waiting for temp...`;
                } else {
                    msg.text = `${pre}waiting for dat...`;
                }
            } else if (node.hasSetpoint) {
                let dat = s.dat;
                msg.text = `${pre}mode: ${mode}, dat: ${dat}, temp: ${(s.temp-100).toFixed(1)}`;
            } else {
                msg.text = `${pre}mode: ${mode}`;
            }
            
            node.status(msg);
        }

        this.calcSetpointAction = function(s, now) {
            // Waiting for DAT input
            if (!s.datTime || now.diff(s.datTime) >= node.tempValidMs) {
                node.datTrip = 'expired';
                s.pending = true;
                return 'idle';
            }

            // DAT limit trip
            if (node.lastAction === 'heating' && s.dat >= node.maxTemp) {
                node.datTrip = 'highLimit';
                return 'idle';
            } else if (node.lastAction === 'cooling' && s.dat <= node.minTemp) {
                node.datTrip = 'lowLimit';
                return 'idle';
            }

            // DAT expiration reset
            if (node.datTrip === 'expired') {
                node.datTrip = now.diff(s.datTime) < node.tempValidMs ? false : 'expired';
                return 'idle';
            }

            // DAT limit resets
            if (node.datTrip === 'highLimit') {
                node.datTrip = s.dat < 90 ? false : 'highLimit';
                return 'idle';
            } else if (node.datTrip === 'lowLimit') {
                node.datTrip = s.dat > 54 ? false : 'lowLimit';
                return 'idle';
            } 

            // Waiting for temperature input
            if (!s.tempTime || now.diff(s.tempTime) >= node.tempValidMs) {
                s.tempValid = false;
                s.pending = true;
                return 'idle';
            }

            // Temp value is current
            if (s.tempTime && now.diff(s.tempTime) < node.tempValidMs) {
                s.tempValid = true;
            }

            // Get Current Capability
            let canHeat = node.hasHeating && (s.mode === 'heat_cool' || s.mode === 'heat');
            let canCool = node.hasCooling && (s.mode === 'heat_cool' || s.mode === 'cool');

            if (node.lastAction === 'heating') { var heatPoint = s.setpoint; } else { var heatPoint = (s.setpoint - node.tolerance + 0.1); }			
            if (node.lastAction === 'cooling') { var coolPoint = s.setpoint; } else { var coolPoint = (s.setpoint + node.tolerance - 0.1); }

            // Calculate what to do based on temp, setpoint and other settings.
            if (node.lastAction === 'heating') { var heatWeightSet = node.heatLowerWeight; } else { var heatWeightSet = node.heatUpperWeight; }
            if (node.lastAction === 'cooling') { var coolWeightSet = node.coolLowerWeight; } else { var coolWeightSet = node.coolUpperWeight; }

            if (canHeat && (s.temp < heatPoint) && (node.heatTriggerTotal > 0) && (node.heatWeightTotal >= heatWeightSet)) {
                if ((!node.lastCoolTime || now.diff(node.lastCoolTime) >= node.swapDelayMs ) && (now.diff(node.lastOffTime) >= node.offTimeMs)) {
                    return 'heating';
                } else if ((now.diff(node.lastCoolTime) < node.swapDelayMs) || now.diff(node.lastOffTime) < node.offTimeMs) {
                    s.pending = true;
                }
            } else if (canCool && s.temp > coolPoint && (node.coolTriggerTotal > 0) && (node.coolWeightTotal >= coolWeightSet)) {
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
                preset: node.preset.get(),
                setpoint: node.setpoint.get(),
                temp: node.temp.get(),
                tempTime: node.temp.time(),
                tempValid: false,
                dat: node.dat.get(),
                datTime: node.dat.time(),
                datTrip: node.datTrip,
                action: offValue,
                heatOutput: node.heatOutput || false,
                coolOutput: node.coolOutput || false,
                changed: false,
                pending: false,
                keepAlive: false,
                heatTrigger: node.heatTriggerTotal || 0,
                heatWeight: node.heatWeightTotal || 0,
                coolTrigger: node.coolTriggerTotal || 0,
                coolWeight: node.coolWeightTotal || 0,
                totalWeight: node.weightTotal || 0
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
                    if (s.keepAlive) {
                        node.send([ null, null, { topic: this.sendTopic, status: s }]);
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

                    if (diff < node.cycleDelayMs) {
                        s.pending = true;
                        //node.updateTimeout = setTimeout(node.update, node.cycleDelayMs - diff);
                        node.updateStatus(s);

                        // Keep sending status keepAlive updates during cycleDelay
                        if (s.keepAlive) {
                            node.send([ null, null, { topic: this.sendTopic, status: s }]);
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
				
                // Save lastOffTime on transition to off
                if ((node.lastAction === 'heating' || node.lastAction === 'cooling') && (s.action === 'off' || s.action === 'idle')) node.lastOffTime = now;

                // Store states for future checks
                node.lastChange = now;
                node.lastAction = s.action;
                node.setValue('action', s.action);
            }

            // Send a message
            if (s.changed || s.keepAlive) {
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
                    node.send([ null, null, { topic: this.sendTopic, status: s }]);
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
                //let s = node.getValue('setpoint');
                //return s === undefined ? node.defaultSetPoint : s; 
                return node.defaultSetPoint;
            };
            this.set = function(s) {
                if (s && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        node.setValue('setpoint', t);
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
                    // Add offset to temp
                    t += 100;
                    if (!isNaN(t)) {
                        node.setValue('temp', t);
                        node.setValue('tempTime', moment().valueOf());
                    }
                }
            };
        };

        // DAT
        function datStore() {
            this.get = function() { 
                let t = node.getValue('dat');
                return t;
            };
            this.time = function() { 
                let t = node.getValue('datTime'); 
                return t ? moment(t) : undefined;
            };
            this.set = function(s) {
                if (s !== undefined && node.hasSetpoint) { 
                    let t = parseFloat(s);
                    if (!isNaN(t)) {
                        node.setValue('dat', t);
                        node.setValue('datTime', moment().valueOf());
                    }
                }
            };
        };

        // Zone weighting and trigger functions
        function zoneWeight(zone, weightValue) {
            let weightCalc = 0;
            let weight = node.getValue("weight") || {};
            weight[(zone)] = (weightValue) || 0;
            
            node.setValue("weight", weight);
            
            for (var prop in weight) {
                weightCalc += weight[prop];
            }
            return weightCalc.toFixed(1);
        };

        function differentialIn(zone, differentialIn) {
            let differentialCalc = 0;
            let differential = node.getValue("differential") || {};
            differential[(zone)] = (differentialIn) || 0;
            
            node.setValue("differential", differential);
            
            for (var prop in differential) {
                differentialCalc += differential[prop];
            }
            return differentialCalc.toFixed(1);
        };

        function weightedDifferentialIn(zone, differentialIn, weightValue) {
            let wDifferentialCalc = 0;
            let wDifferential = node.getValue("wDifferential") || {};
            wDifferential[(zone)] = (((differentialIn) || 0) * ((weightValue) || 1));

            node.setValue("wDifferential", wDifferential);
            
            for (var prop in wDifferential) {
                wDifferentialCalc += wDifferential[prop];
            }
            return wDifferentialCalc.toFixed(1);
        };

        function heatTriggerZones(zone, triggerIn, heatIn) {
            let heatTriggerCalc = 0;
            let heatTrigger = node.getValue("heatTrigger") || {};
            heatTrigger[(zone)] = ((triggerIn) == true && (heatIn) == true) ? 1 : 0;

            node.setValue("heatTrigger", heatTrigger);

            for (var prop in heatTrigger) {
                heatTriggerCalc += heatTrigger[prop];
            }
            return heatTriggerCalc;
        };

        function coolTriggerZones(zone, triggerIn, coolIn) {
            let coolTriggerCalc = 0;
            let coolTrigger = node.getValue("coolTrigger") || {};
            coolTrigger[(zone)] = ((triggerIn) == true && (coolIn) == true) ? 1 : 0;

            node.setValue("coolTrigger", coolTrigger);

            for (var prop in coolTrigger) {
                coolTriggerCalc += coolTrigger[prop];
            }
            return coolTriggerCalc;
        };

        function activeHeatWeight(zone, weightValue, heatIn) {
            let activeHeatWeightCalc = 0;
            let heatWeight = node.getValue("heatWeight") || {};
            heatWeight[(zone)] = (((weightValue) || 1) * ((heatIn) == true ? 1 : 0));

            node.setValue("heatWeight", heatWeight);
            
            for (var prop in heatWeight) {
                activeHeatWeightCalc += heatWeight[prop];
            }
            return activeHeatWeightCalc;
        };

        function activeCoolWeight(zone, weightValue, coolIn) {
            let activeCoolWeightCalc = 0;
            let coolWeight = node.getValue("coolWeight") || {};
            coolWeight[(zone)] = (((weightValue) || 1) * ((coolIn) == true ? 1 : 0));

            node.setValue("coolWeight", coolWeight);
            
            for (var prop in coolWeight) {
                activeCoolWeightCalc += coolWeight[prop];
            }
            return activeCoolWeightCalc;
        };

        // Init Things
        node.mode = new modeStore();
        node.preset = new presetStore();
        node.setpoint = new setpointStore();
        node.temp = new tempStore();
        node.dat = new datStore();

        // If a broker is specified we create an mqtt handler
        if (node.broker && node.topic) {
            node.mqtt = new mqtt(node.deviceId, node.advertise, node.topic, node.broker, node.onMqttConnect, node.onMqttSet);
        }

        node.setValue("weight", undefined);
        node.setValue("differential", undefined);
        node.setValue("wDifferential", undefined);
        node.setValue("heatTrigger", undefined);
        node.setValue("coolTrigger", undefined);
        node.setValue("heatWeight", undefined);
        node.setValue("coolWeight", undefined);

        // Initial update
        node.setStatus({fill:'grey', shape:'dot', text:'starting...'});

        // Start with null temp and dat times
        node.setValue('datTime', null);
        node.setValue('tempTime', null);

        setTimeout(function() { 
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
