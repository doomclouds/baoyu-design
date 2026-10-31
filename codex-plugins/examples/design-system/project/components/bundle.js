/* @ds-bundle: {"format":4,"namespace":"Nimbus","components":[{"name":"Button","group":"Actions"},{"name":"WeatherCard","group":"Weather"},{"name":"ForecastSwitch","group":"Controls"}]} */
(function () {
  'use strict';
  const React = window.React;
  const h = React.createElement;

  function Button({ variant = 'quiet', disabled = false, onClick, children, ...rest }) {
    return h('button', { ...rest, type: 'button', disabled, onClick,
      className: 'nb-button label nb-button-' + variant }, children);
  }

  function WeatherGlyph() {
    return h('svg', { className: 'nb-weather-glyph', viewBox: '0 0 64 56', fill: 'none', 'aria-hidden': true },
      h('path', { d: 'M17 35C10 35 6 31 6 25C6 20 10 16 15 15C18 7 27 4 34 8C38 10 40 13 41 17C49 16 56 21 56 27C56 32 52 35 46 35H17Z', stroke: 'currentColor', strokeWidth: 3, strokeLinejoin: 'round' }),
      h('path', { d: 'M20 43L17 49M33 43L30 49M46 43L43 49', stroke: 'currentColor', strokeWidth: 3, strokeLinecap: 'round' }));
  }

  function WeatherCard({ city = '杭州', temperature = 18, condition = '小雨将在午前渐歇', feelsLike = 16, high = 21, low = 15, humidity = 78 }) {
    const [unit, setUnit] = React.useState('C');
    const convert = value => unit === 'C' ? value : Math.round(value * 9 / 5 + 32);
    return h('article', { className: 'nb-weather-card', 'aria-label': city + '天气示例' },
      h('header', { className: 'nb-weather-header' },
        h('div', null, h('h2', { className: 'nb-weather-place title' }, city), h('p', { className: 'nb-weather-updated caption' }, '刚刚更新')),
        h('button', { type: 'button', className: 'nb-unit label', 'aria-label': unit === 'C' ? '切换到华氏温度' : '切换到摄氏温度',
          onClick: () => setUnit(unit === 'C' ? 'F' : 'C') }, '°' + unit)),
      h('div', { className: 'nb-weather-reading' },
        h('p', { className: 'nb-weather-temp reading', 'aria-live': 'polite' }, convert(temperature) + '°'), h(WeatherGlyph)),
      h('p', { className: 'nb-weather-condition body' }, condition),
      h('div', { className: 'nb-weather-metrics caption' },
        h('span', null, '体感 ', convert(feelsLike) + '°'),
        h('span', null, '最高 ', convert(high) + '°'),
        h('span', null, '最低 ', convert(low) + '°'),
        h('span', null, '湿度 ', humidity + '%')));
  }

  function ForecastSwitch({ value, defaultValue = 'today', onChange }) {
    const [internal, setInternal] = React.useState(defaultValue);
    const selected = value === undefined ? internal : value;
    return h('div', { className: 'nb-switch', role: 'group', 'aria-label': '预报时间范围' },
      [['today', '今天'], ['tomorrow', '明天'], ['week', '七天']].map(([id, label]) =>
        h('button', { key: id, type: 'button', className: 'label', 'aria-pressed': selected === id,
          onClick: () => { setInternal(id); onChange?.(id); } }, label)));
  }

  window.Nimbus = Object.freeze({ Button, WeatherCard, ForecastSwitch });
})();
