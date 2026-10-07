export const localAccountStorage = {
  async read(key: string) {
    return window.localStorage.getItem(key);
  },
  async write(key: string, value: string) {
    window.localStorage.setItem(key, value);
  },
  async remove(key: string) {
    window.localStorage.removeItem(key);
  },
};
