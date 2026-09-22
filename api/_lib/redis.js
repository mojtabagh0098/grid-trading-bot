/** Minimal Upstash Redis REST client. No npm package is required. */
export class RedisStore {
  constructor({ url, token }) {
    this.url = url;
    this.token = token;
  }

  async command(command, ...args) {
    const response = await fetch(this.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify([command, ...args])
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) {
      throw new Error(payload.error || `Redis error (${response.status})`);
    }
    return payload.result;
  }

  async getJson(key) {
    const value = await this.command('GET', key);
    if (value === null || value === undefined) return null;
    try {
      return JSON.parse(value);
    } catch {
      throw new Error(`Invalid JSON stored in Redis key ${key}`);
    }
  }

  async setJson(key, value, ttlSeconds) {
    const json = JSON.stringify(value);
    if (ttlSeconds) return this.command('SET', key, json, 'EX', String(ttlSeconds));
    return this.command('SET', key, json);
  }
}

export function createRedis(config) {
  return new RedisStore({ url: config.upstashUrl, token: config.upstashToken });
}
