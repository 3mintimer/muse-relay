// Declarative data only. Shared by the app, Node/Worker relay and Gist adapter.
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const short = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max;
const invalid = () => { throw new Error('Invalid space control'); };
export function sliderValue(control, value) {
  const steps = Math.round((value - control.min) / control.step);
  return Number(Math.min(control.max, Math.max(control.min, control.min + steps * control.step)).toFixed(6));
}
export function parseSpaceControl(value) {
  if (!object(value)) return invalid();
  const base = {type:value.type, ...(value.disabled === true ? {disabled:true} : {})};
  if (value.type === 'button') {
    if (value.label !== undefined && !short(value.label, 60) || value.confirm !== undefined && !short(value.confirm, 300)) return invalid();
    return {...base, ...(value.label ? {label:value.label} : {}), ...(value.confirm ? {confirm:value.confirm} : {})};
  }
  if (value.type === 'microphone') return base;
  if (value.type === 'slider') {
    const {min, max, step, value:current} = value;
    if (![min,max,step,current].every(Number.isFinite) || min >= max || step < 0.000001 || step > max-min
      || Math.max(Math.abs(min),Math.abs(max)) > 1_000_000 || (max-min)/step > 10_000
      || current < min || current > max || Math.abs((max-min)/step - Math.round((max-min)/step)) > 0.000001
      || value.unit !== undefined && !short(value.unit, 16)) return invalid();
    const result = {...base,min,max,step,value:current,...(value.unit ? {unit:value.unit} : {})};
    result.value = sliderValue(result,current); return result;
  }
  if (value.type === 'choice') {
    if (!Array.isArray(value.options) || !value.options.length || value.options.length > 12) return invalid();
    const seen = new Set();
    const options = value.options.map(option => {
      if (!object(option) || !id(option.id) || seen.has(option.id) || !short(option.title,60)) return invalid();
      seen.add(option.id); return {id:option.id,title:option.title};
    });
    if (value.value !== undefined && !seen.has(value.value)) return invalid();
    return {...base,options,...(value.value !== undefined ? {value:value.value} : {})};
  }
  return invalid();
}
export function parseSpaceAction(value) {
  if (!object(value) || !id(value.item_id) || !['button','slider','choice','microphone'].includes(value.type)) return invalid();
  if (value.type === 'slider' ? !Number.isFinite(value.value) : value.type === 'choice' ? !id(value.value) : value.value !== undefined) return invalid();
  return {item_id:value.item_id,type:value.type,...(value.value !== undefined ? {value:value.value} : {})};
}
export function matchesSpaceAction(control, action) {
  if (!control || control.disabled || control.type !== action.type) return false;
  if (control.type === 'slider') return Number.isFinite(action.value) && action.value >= control.min && action.value <= control.max
    && Math.abs(sliderValue(control,action.value)-action.value) < 0.0000001;
  if (control.type === 'choice') return control.options.some(option => option.id === action.value);
  return action.value === undefined;
}
