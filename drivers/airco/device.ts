import Homey from 'homey';
import { login, sendControl, listDevices, parseControlState, parseAmbientTemperature } from '../../lib/auxcloud/client';
import {
  HOMEY_MODE_TO_AUX,
  AUX_MODE_TO_HOMEY,
  HOMEY_FAN_TO_AUX,
  WIRE_FAN_TO_HOMEY,
  getCountryFromTimezone,
} from '../../lib/auxcloud/constants';
import {
  login as legacyLogin,
  listDevices as legacyListDevices,
  setParam as legacySetParam,
  LegacyAuxLoginResult,
  LegacyAuxDevice,
} from '../../lib/auxcloud/legacyClient';
import {
  LegacyRegion,
  LEGACY_MODE_TO_HOMEY,
  HOMEY_MODE_TO_LEGACY,
  LEGACY_FAN_TO_HOMEY,
  HOMEY_FAN_TO_LEGACY,
} from '../../lib/auxcloud/legacyConstants';

const POLL_INTERVAL_MS = 60 * 1000;

module.exports = class AircoDevice extends Homey.Device {

  private bearer: string | null = null;
  private country: string = 'NLD';
  private legacySession: LegacyAuxLoginResult | null = null;
  private legacyDevice: LegacyAuxDevice | null = null;
  private pollInterval: NodeJS.Timeout | null = null;
  private destroyed = false;

  private get isLegacy(): boolean {
    return this.getStore().protocol === 'legacy';
  }

  async onInit() {
    if (this.isLegacy) {
      await this.ensureLegacyLoggedIn();
    } else {
      // Devices paired before country-detection existed have no stored
      // value -- resolve it once from the Homey's own timezone and persist
      // it so it doesn't need to be re-derived on every restart.
      let country = this.getStoreValue('country') as string | null;
      if (!country) {
        const timezone = await this.homey.clock.getTimezone();
        country = getCountryFromTimezone(timezone);
        await this.setStoreValue('country', country);
      }
      this.country = country;

      this.bearer = (this.getStoreValue('bearer') as string | null) ?? null;
      if (!this.bearer) await this.ensureLoggedIn();
    }

    this.registerCapabilityListener('onoff', async (value: boolean) => {
      await this.sendIntent({ new: { on_off: value ? 1 : 0 }, legacy: { pwr: value ? 1 : 0 } });
    });

    this.registerCapabilityListener('thermostat_mode', async (value: string) => {
      await this.sendIntent({
        new: { air_con_func: HOMEY_MODE_TO_AUX[value] ?? 0 },
        legacy: { ac_mode: HOMEY_MODE_TO_LEGACY[value] ?? 4 },
      });
    });

    this.registerCapabilityListener('target_temperature', async (value: number) => {
      const rounded = Math.round(value * 2) / 2;
      await this.sendIntent({
        new: { temperature: rounded },
        legacy: { temp: Math.round(rounded * 10) },
      });
    });

    this.registerCapabilityListener('aux_fan_speed', async (value: string) => {
      await this.sendIntent({
        new: { wind_speed: HOMEY_FAN_TO_AUX[value] ?? 4 },
        legacy: { ac_mark: HOMEY_FAN_TO_LEGACY[value] ?? 0 },
      });
    });

    this.pollInterval = this.homey.setInterval(() => this.pollState(), POLL_INTERVAL_MS);
    await this.pollState();
  }

  async onUninit() {
    this.destroyed = true;
    if (this.pollInterval) this.homey.clearInterval(this.pollInterval);
  }

  // AUX's login response only returns a single session token, no separate
  // refresh token (confirmed against the live API) -- there is nothing else
  // to persist here.
  private async ensureLoggedIn(): Promise<void> {
    const { email, password } = this.getStore();
    const result = await login(email, password, this.country);
    this.bearer = result.token;
    await this.setStoreValue('bearer', result.token);
  }

  private async ensureLegacyLoggedIn(): Promise<void> {
    const { email, password, region } = this.getStore();
    this.legacySession = await legacyLogin(email, password, region as LegacyRegion);
  }

  private async sendIntent(intent: { new: Record<string, number>; legacy: Record<string, number> }): Promise<void> {
    if (this.isLegacy) {
      await this.sendLegacyIntent(intent.legacy);
    } else {
      await this.sendNewIntent(intent.new);
    }
  }

  private async sendNewIntent(intent: Record<string, number>): Promise<void> {
    const { id } = this.getData();
    if (!this.bearer) await this.ensureLoggedIn();
    try {
      await sendControl(this.bearer as string, id, intent, 1, this.country);
    } catch (err) {
      // Session may have expired: log in again and retry once.
      await this.ensureLoggedIn();
      await sendControl(this.bearer as string, id, intent, 1, this.country);
    }
  }

  private async sendLegacyIntent(intent: Record<string, number>): Promise<void> {
    if (!this.legacySession) await this.ensureLegacyLoggedIn();
    if (!this.legacyDevice) await this.pollLegacyState();
    if (!this.legacyDevice) throw new Error('Device not found on the legacy AUX Cloud backend.');

    const [param, value] = Object.entries(intent)[0];
    const region = this.getStore().region as LegacyRegion;
    const runOnce = () => legacySetParam(this.legacySession as LegacyAuxLoginResult, region, this.legacyDevice as LegacyAuxDevice, param, value);
    try {
      await runOnce();
    } catch (err) {
      // Session may have expired: log in again and retry once.
      await this.ensureLegacyLoggedIn();
      await runOnce();
    }
  }

  // Runs unattended on a timer, so it must never throw -- an uncaught
  // rejection here would otherwise surface as a device error for things
  // that are routinely transient (a session that expired between the retry
  // attempt, AUX's own server hiccuping, a network blip, or the device
  // having been deleted from Homey while a poll was already in flight).
  // Log and let the next scheduled poll try again instead.
  private async pollState(): Promise<void> {
    if (this.destroyed) return;
    try {
      if (this.isLegacy) {
        await this.pollLegacyState();
      } else {
        await this.pollNewState();
      }
    } catch (err) {
      if (!this.destroyed) this.error('Poll failed, will retry next cycle:', err);
    }
  }

  private async pollNewState(): Promise<void> {
    const { id } = this.getData();
    if (!this.bearer) await this.ensureLoggedIn();

    let devices;
    try {
      devices = await listDevices(this.bearer as string, this.country);
    } catch (err) {
      await this.ensureLoggedIn();
      devices = await listDevices(this.bearer as string, this.country);
    }

    const device = devices.find((d) => d.deviceId === id);
    if (!device) return;

    const state = parseControlState(device.status.control);

    await this.safeSetCapabilityValue('onoff', state.onoff);
    await this.safeSetCapabilityValue('thermostat_mode', AUX_MODE_TO_HOMEY[state.mode] ?? 'auto');
    await this.safeSetCapabilityValue('target_temperature', state.targetTemperature);
    await this.safeSetCapabilityValue('aux_fan_speed', WIRE_FAN_TO_HOMEY[state.fanSpeedWire] ?? 'auto');
    await this.safeSetCapabilityValue('measure_temperature', parseAmbientTemperature(device.status.running));
    // state.swingActive is readable but not yet split into vertical vs.
    // horizontal, so there's no Homey capability for it yet.
  }

  private async pollLegacyState(): Promise<void> {
    const { id } = this.getData();
    const region = this.getStore().region as LegacyRegion;
    if (!this.legacySession) await this.ensureLegacyLoggedIn();

    let devices;
    try {
      devices = await legacyListDevices(this.legacySession as LegacyAuxLoginResult, region);
    } catch (err) {
      await this.ensureLegacyLoggedIn();
      devices = await legacyListDevices(this.legacySession as LegacyAuxLoginResult, region);
    }

    const device = devices.find((d) => d.endpointId === id);
    if (!device) return;
    this.legacyDevice = device;

    const p = device.params;
    await this.safeSetCapabilityValue('onoff', p.pwr === 1);
    await this.safeSetCapabilityValue('thermostat_mode', LEGACY_MODE_TO_HOMEY[p.ac_mode] ?? 'auto');
    if (typeof p.temp === 'number') await this.safeSetCapabilityValue('target_temperature', p.temp / 10);
    await this.safeSetCapabilityValue('aux_fan_speed', LEGACY_FAN_TO_HOMEY[p.ac_mark] ?? 'auto');
    if (typeof p.envtemp === 'number') await this.safeSetCapabilityValue('measure_temperature', p.envtemp / 10);
    // ac_vdir/ac_hdir (swing) aren't mapped to a capability yet, same as
    // the new backend's unresolved vertical-vs-horizontal swing status.
  }

  private async safeSetCapabilityValue(capability: string, value: unknown): Promise<void> {
    try {
      await this.setCapabilityValue(capability, value as never);
    } catch (err) {
      this.error(`Could not update ${capability}:`, err);
    }
  }

};
