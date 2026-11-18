import type {SpaceControl,SpaceAction} from '../src/core/types';
export function parseSpaceControl(value:unknown):SpaceControl;
export function parseSpaceAction(value:unknown):SpaceAction;
export function sliderValue(control:Extract<SpaceControl,{type:'slider'}>,value:number):number;
export function matchesSpaceAction(control:SpaceControl|undefined,action:SpaceAction):boolean;
