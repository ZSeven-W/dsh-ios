import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { listDevices, getDevice } from './simctl.js'
import { isFoldableSimulator, runStreamHingeAction, type HingeArgs } from './hinge.js'
import type { SimHostController } from './sim-host.js'

export function createSimHingeTool(host: SimHostController): ToolDefinition {
  return defineTool({
    name: 'ios_sim_hinge',
    description: 'Read or control an iPhone Duo SIMULATOR hinge: status, fold (0°), unfold (180°), '
      + 'half (90°), set an angle from 0 to 180, or select portrait/landscape for the active display. Physical devices cannot be folded by software. '
      + 'Requires Xcode 27.1+ with an iPhone Duo runtime. Mutations read back CoreMotion and the active display; '
      + 'a failed angle or endpoint display transition throws, never reports success. Intermediate angles '
      + 'do not imply a particular display; inspect activeDisplay. Capture with ios_sim_screenshot afterwards.',
    parameters: {
      udid: { type: 'string', description: 'Booted iPhone Duo simulator UDID/name. Omit only when one unambiguous Duo is booted.' },
      action: { type: 'string', enum: ['status', 'fold', 'unfold', 'half', 'set', 'portrait', 'landscape'], description: 'Default status. Portrait/landscape refer to the active screen, including the unfolded inner display.' },
      angle: { type: 'number', description: '0–180 degrees. Required only for action set.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: true, properties: { supported: { type: 'boolean', required: true } } },
      render: (_args: unknown, value: unknown) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    timeoutMs: 180_000,
    async execute(args: HingeArgs & { udid?: string }, exec) {
      let device
      if (args.udid?.trim()) device = await getDevice(args.udid)
      else {
        const duos = (await listDevices()).filter(d => d.state === 'Booted' && isFoldableSimulator(d))
        const streamed = duos.find(d => d.udid === host.status().device)
        if (streamed !== undefined) device = streamed
        else if (duos.length === 1) device = duos[0]
        else throw new Error(duos.length === 0 ? 'no booted iPhone Duo simulator; run ios_sim_devices first' : 'several iPhone Duo simulators are booted; pass udid explicitly')
      }
      return runStreamHingeAction(host, device, args, exec.signal)
    },
  })
}
