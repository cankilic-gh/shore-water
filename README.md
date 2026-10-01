# Shore Water

An interactive shoreline diorama in the browser. A shallow-water simulation runs on the GPU every frame: waves roll in from the open edge, steepen over a sandbar, run up the beach and drain back, leaving wet sand that slowly dries. A mallard walks, swims and flaps its way onto the rocks.

Live: https://shorewater.thegridbase.com

## How it works

- **Water simulation:** a virtual-pipes shallow-water solver on a 256² grid (12.5 cm cells, 32 m × 32 m). It is fixed-step at 120 Hz in float render targets, with wave forcing from the open edge and wet/dry handling at the shoreline.
- **Foam:** a scalar field that forms where waves break, where the flow converges, at the swash front and in the wake. It is advected semi-Lagrangian with the velocity field and rendered as layered Voronoi lace with a two-phase flow map.
- **Water shading:** the opaque scene is copied with linear depth. The surface refracts through it with Beer–Lambert absorption, in-scattering, Fresnel sky reflection and sun glints. Caustics and depth absorption are applied on the seabed.
- **Land:** procedural heightfield with wind ripples, a wetness memory that dries over time, grooves left by the duck, about 110k instanced grass blades, and faceted procedural rocks stamped into the simulation bed.
- **Duck:** a mallard built procedurally in Blender (`tools/duck.py`) and animated in code: waddle, head bob, paddling, wing-flap double jump and glide. It displaces the water and rides the currents.
- **Post:** half-resolution gather bokeh for a tilt-shift depth of field, then ACES tone mapping.

## Controls

WASD / arrows to move, Space to jump (press again mid-air to flap, hold to glide), mouse to orbit. On touch devices: on-screen stick and JUMP button.

## Development

```bash
npm install
npm run dev
npm run build
```

Rebuild the duck model (Blender 5.x):

```bash
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --python tools/duck.py -- public/models/duck.glb
```

Append `?debug` to the URL to expose `window.__shore` for automated screenshots.
