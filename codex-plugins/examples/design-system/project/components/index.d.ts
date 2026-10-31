export interface ButtonProps { variant?: 'primary' | 'quiet'; disabled?: boolean; onClick?: () => void; children?: unknown }
export declare function Button(props: ButtonProps): unknown;
export interface WeatherCardProps { city?: string; temperature?: number; condition?: string; feelsLike?: number; high?: number; low?: number; humidity?: number }
export declare function WeatherCard(props: WeatherCardProps): unknown;
export interface ForecastSwitchProps { value?: 'today' | 'tomorrow' | 'week'; defaultValue?: 'today' | 'tomorrow' | 'week'; onChange?: (value: 'today' | 'tomorrow' | 'week') => void }
export declare function ForecastSwitch(props: ForecastSwitchProps): unknown;
