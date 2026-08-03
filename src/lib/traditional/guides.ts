export interface GuideStepDef {
  id: string;
  title: string;
  description: string;
}

export const GUIDES: Record<string, GuideStepDef[]> = {
  drip_shower: [
    {
      id: 's1',
      title: 'Isolate the water',
      description: 'Turn off the isolation valves for the shower mixer. Place a towel under the spout.',
    },
    {
      id: 's2',
      title: 'Check the cartridge',
      description: 'Remove the handle and cover plate. Inspect the ceramic cartridge for wear or debris.',
    },
    {
      id: 's3',
      title: 'Clean or replace',
      description: 'Rinse the cartridge seats. If the drip continues after reassembly, replace the cartridge.',
    },
    {
      id: 's4',
      title: 'Reassemble and test',
      description: 'Refit the plate and handle, restore water, and check for drips at the spout and wall.',
    },
  ],
  low_pressure: [
    {
      id: 'p1',
      title: 'Check isolation valves',
      description: 'Confirm both hot and cold isolators are fully open.',
    },
    {
      id: 'p2',
      title: 'Inspect the flow restrictor',
      description: 'Remove the handpiece/aerators and flush debris from the restrictor.',
    },
    {
      id: 'p3',
      title: 'Test one outlet at a time',
      description: 'If only one outlet is weak, the issue is local; if all are weak, check the supply.',
    },
  ],
  mixer_switch: [
    {
      id: 'm1',
      title: 'Confirm diverter position',
      description: 'Cycle the diverter fully between bath, hand shower, and overhead.',
    },
    {
      id: 'm2',
      title: 'Flush the in-wall body',
      description: 'Remove the cartridge and flush the EasySwitch® body before reinstalling.',
    },
    {
      id: 'm3',
      title: 'Replace if sticky',
      description: 'A sticky diverter usually means the cartridge needs replacement.',
    },
  ],
  install_shower: [
    {
      id: 'i1',
      title: 'Fit the in-wall body',
      description: 'Install the EasySwitch® bath/shower in-wall body at the correct setout depth before tiling.',
    },
    {
      id: 'i2',
      title: 'Pressure test',
      description: 'Cap outlets and pressure-test the rough-in before lining/tiling.',
    },
    {
      id: 'i3',
      title: 'Fit trim and outlets',
      description: 'After tiling, fit the mixer trim, rail/overhead, and seal penetrations.',
    },
    {
      id: 'i4',
      title: 'Commission',
      description: 'Restore water, check mixing temperature, and confirm no leaks at joints.',
    },
  ],
  install_general: [
    {
      id: 'g1',
      title: 'Confirm parts on site',
      description: 'Check primary products plus mandatory in-wall/installation parts against the quote BOM.',
    },
    {
      id: 'g2',
      title: 'Follow product setout',
      description: 'Use the product installation sheet for setout heights and clearances.',
    },
    {
      id: 'g3',
      title: 'Seal and commission',
      description: 'Seal wet-area penetrations, restore supply, and run a final leak check.',
    },
  ],
};

export function pickGuide(answers: Record<string, string>, context: 'troubleshoot' | 'install'): GuideStepDef[] {
  if (context === 'install') return GUIDES.install_shower;

  const symptom = (answers.symptom || '').toLowerCase();
  if (symptom.includes('drip') || symptom.includes('leak')) return GUIDES.drip_shower;
  if (symptom.includes('pressure')) return GUIDES.low_pressure;
  if (symptom.includes('switching') || symptom.includes('mixer')) return GUIDES.mixer_switch;
  return GUIDES.install_general;
}
