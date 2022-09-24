import { API, AccessoryPlugin, AccessoryConfig, Logger, Service, Characteristic } from 'homebridge';
import { PLUGIN_NAME } from './settings';
import axios = require('axios');


// module.exports = (api) => {
//     api.registerAccessory('ExampleAccessoryName', ExampleAccessoryPlugin);
// };

enum DeviceStatus {
    Normal = 0,
    NoServer,
    NoProbe
}

interface IReadings {
    battery: number;
    temps: (boolean | number)[];
}

export class IGrillAccessory implements AccessoryPlugin {
    public readonly Service: typeof Service = this.api.hap.Service;
    public readonly Characteristic: typeof Characteristic = this.api.hap.Characteristic;

    private informationService;
    private tempSensors: Service[] = [];
    private currentStatus: DeviceStatus = DeviceStatus.Normal;
    private name: string;
    private axInstance: axios.AxiosInstance;

    private readings: IReadings = {
        battery: 0,
        temps: [],
    };

    private lastReadingTime = 0;

    /**
     * REQUIRED - This is the entry point to your plugin
     */
    constructor(
        public readonly log: Logger,
        public readonly config: AccessoryConfig,
        public readonly api: API,
    ) {
        this.log = log;
        this.config = config;
        this.api = api;
        this.name = PLUGIN_NAME;
        this.axInstance = axios.default.create({
            baseURL: `http://${config.serverAddress}:${config.port}`,
        });

        this.log.debug('iGrill Plugin Loaded');

        // your accessory must have an AccessoryInformation service
        this.informationService = new this.api.hap.Service.AccessoryInformation(this.name)
            .setCharacteristic(this.api.hap.Characteristic.Name, 'Weber-iGrill-V3')
            .setCharacteristic(this.api.hap.Characteristic.Manufacturer, 'Weber')
            .setCharacteristic(this.api.hap.Characteristic.Model, 'iGrill-V2');


        for (let i = 0; i < 4; i++) {
            this.tempSensors[i] = new this.api.hap.Service.TemperatureSensor('Probe-' + (i + 1).toString(), `probe_${i + 1}`);
            this.tempSensors[i].name = 'Probe-' + i + 1;
            this.tempSensors[i].getCharacteristic(this.Characteristic.CurrentTemperature)
                .onGet(() => {
                    // await this.getStatusFromDevice();
                    this.log.debug('Received get current temp for probe ' + i);
                    if (this.currentStatus === DeviceStatus.Normal) {
                        this.log.debug('Returning value: ' + this.getProbeValue(i));
                        return this.getProbeValue(i);
                    } else if (this.currentStatus === DeviceStatus.NoServer) {
                        this.log.error('Server unreachable');
                        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    } else {
                        // Means Probe is off or not connected to server
                        this.log.error('iGrill not connected to server');
                        throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
                    }
                    //return this.convertToCelcius(0);
                });
            this.tempSensors[i].getCharacteristic(this.Characteristic.StatusActive)
                .onGet(() => {
                    if (this.currentStatus !== DeviceStatus.Normal || !this.readings.temps[i]) {
                        return false;
                    } else {
                        return true;
                    }
                });
        }

        // Start update interval
        this.getStatusFromDevice.bind(this);
        this.updateHomebridge.bind(this);
        setInterval(async () => {
            await this.getStatusFromDevice();
            this.updateHomebridge();
        }, 5000);
    }


    /**
     * REQUIRED - This must return an array of the services you want to expose.
     * This method must be named "getServices".
     */
    getServices() {
        return [this.informationService].concat(this.tempSensors);
    }

    private updateHomebridge() {
        //if (this.currentStatus === DeviceStatus.Normal) {
        for (let i = 0; i < this.tempSensors.length; i++) {
            if (this.readings.temps[i] !== false) {
                this.tempSensors[i].updateCharacteristic(this.Characteristic.StatusActive, true);
                this.tempSensors[i].updateCharacteristic(this.Characteristic.CurrentTemperature, this.getProbeValue(i));
                this.log.debug(`Updating probe ${i}: ${this.getProbeValue(i)}`);
            } else {
                this.tempSensors[i].updateCharacteristic(this.Characteristic.StatusActive, false);
                this.tempSensors[i].updateCharacteristic(this.Characteristic.CurrentTemperature, this.getProbeValue(i));
                this.log.debug(`Updating probe ${i}: ${this.getProbeValue(i)}`);
            }
        }
        //           }
        //       } else if (this.currentStatus === DeviceStatus.NoServer) {
        if (this.currentStatus === DeviceStatus.NoServer) {
            this.log.info('iGrill Server seems to be down');
            for (let i = 0; i < this.tempSensors.length; i++) {
                this.tempSensors[i].updateCharacteristic(this.Characteristic.StatusActive, false);
            }
        } else if (this.currentStatus === DeviceStatus.NoProbe) {
            this.log.info('iGrill Probe is not connected to server - may be off');
            for (let i = 0; i < this.tempSensors.length; i++) {
                this.tempSensors[i].updateCharacteristic(this.Characteristic.StatusActive, false);
            }
        }

    }

    private convertToCelcius(f: number | boolean) {
        if (typeof f === 'number') {
            return (f - 32) * (5 / 9);
        } else {
            return -32 * (5 / 9);
        }
    }

    private getProbeValue(probeNumber: number) {
        const temp = this.readings.temps[probeNumber];

        if (!temp) {
            return this.convertToCelcius(0);
        } else {
            return (this.convertToCelcius(temp));
        }
    }

    private async getStatusFromDevice() {
        return new Promise<void>((resolve) => {
            this.axInstance.get('/readings')
                .then(res => {
                    this.readings = res.data;
                    this.currentStatus = DeviceStatus.Normal;
                    resolve();
                })
                .catch((error) => {
                    for (let i = 0; i < this.readings.temps.length; i++) {
                        this.readings.temps[i] = false;
                    }
                    if (error.code === 'ECONNREFUSED') {
                        this.log.error('Cannot conect to server');
                        this.currentStatus = DeviceStatus.NoServer;
                        resolve();
                    } else {
                        // Assume a 404 which means the sensor is off or not connected to server
                        this.log.info('iGrill appears to be off or not connected to server');
                        this.currentStatus = DeviceStatus.NoProbe;
                        resolve;
                    }
                });
        });
    }

    async getBattery() {
        return this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
    }

}