# Procedural mallard drake for Shore Water.
# Run: Blender --background --factory-startup --python tools/duck.py -- <out.glb> [preview.png]
# Blender is Z-up with the duck facing -Y; the glTF export converts to Y-up facing +Z.
import math
import sys

import bmesh
import bpy
from mathutils import Vector, noise

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
OUT = argv[0] if argv else "/tmp/duck.glb"
PREVIEW = argv[1] if len(argv) > 1 else None

bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()


def smooth(a, b, x):
    t = min(max((x - a) / (b - a), 0.0), 1.0)
    return t * t * (3 - 2 * t)


def mix(c1, c2, t):
    return tuple(c1[i] + (c2[i] - c1[i]) * t for i in range(3))


def metaball_mesh(name, elements, resolution=0.007):
    mb = bpy.data.metaballs.new(name + "_mb")
    mb.resolution = resolution
    mb.render_resolution = resolution
    mb.threshold = 0.6
    for el in elements:
        e = mb.elements.new(type=el.get("type", "BALL"))
        e.co = el["co"]
        e.radius = el["r"]
        if "size" in el:
            e.size_x, e.size_y, e.size_z = el["size"]
        if "stiff" in el:
            e.stiffness = el["stiff"]
    obj = bpy.data.objects.new(name + "_tmp", mb)
    bpy.context.collection.objects.link(obj)
    bpy.context.view_layer.update()
    deps = bpy.context.evaluated_depsgraph_get()
    mesh = bpy.data.meshes.new_from_object(obj.evaluated_get(deps))
    bpy.data.objects.remove(obj)
    bpy.data.metaballs.remove(mb)
    out = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(out)
    return out


def paint(obj, fn):
    mesh = obj.data
    attr = mesh.color_attributes.get("Col") or mesh.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
    mw = obj.matrix_world
    for v in mesh.vertices:
        p = mw @ v.co
        c = fn(p)
        attr.data[v.index].color = (c[0], c[1], c[2], 1.0)
    mesh.color_attributes.active_color = attr


def decimate(obj, ratio):
    m = obj.modifiers.new("dec", "DECIMATE")
    m.ratio = ratio
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.modifier_apply(modifier=m.name)
    obj.select_set(False)


def shade_smooth(obj):
    for poly in obj.data.polygons:
        poly.use_smooth = True


def set_origin(obj, point):
    point = Vector(point)
    obj.data.transform(__import__("mathutils").Matrix.Translation(-point))
    obj.location = point


def join(objs, name):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    objs[0].name = name
    objs[0].data.name = name
    return objs[0]


def sphere(name, radius, loc, scale=(1, 1, 1), segs=24, rings=16):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segs, ring_count=rings, radius=radius, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = scale
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    return o


# Palette (linear)
GREEN = (0.012, 0.11, 0.035)
GREEN_HI = (0.03, 0.2, 0.09)
WHITE = (0.8, 0.8, 0.78)
CHESTNUT = (0.2, 0.065, 0.025)
GREY = (0.5, 0.49, 0.46)
GREY_DARK = (0.2, 0.18, 0.15)
BLACK = (0.012, 0.012, 0.014)
BILL = (0.75, 0.52, 0.04)
ORANGE = (0.95, 0.32, 0.03)
WING = (0.22, 0.19, 0.155)
SPECULUM = (0.02, 0.05, 0.42)

# ---------------- Body ----------------
# Metaball surface radius is ~0.57 * r; ellipsoid sizes are multipliers on that.
body = metaball_mesh("Body", [
    {"type": "ELLIPSOID", "co": (0, 0.02, 0.165), "r": 0.19, "size": (0.95, 1.45, 0.72)},
    {"co": (0, -0.1, 0.19), "r": 0.14},
    {"type": "ELLIPSOID", "co": (0, 0.185, 0.2), "r": 0.1, "size": (0.8, 1.2, 0.4)},
    {"co": (0, 0.24, 0.222), "r": 0.026},
    {"co": (0, -0.14, 0.255), "r": 0.095},
])
for v in body.data.vertices:
    p = v.co
    if p.z < 0.12:  # flatter keel so it floats like a hull
        p.z = 0.12 - (0.12 - p.z) * 0.72


def body_color(p):
    n = noise.noise(p * 90.0)
    flank = mix(GREY, (0.62, 0.61, 0.58), 0.5 + 0.5 * n)
    c = flank
    c = mix(c, GREY_DARK, smooth(0.235, 0.27, p.z) * (1 - smooth(0.1, 0.16, -p.y)))
    c = mix(c, (0.68, 0.67, 0.64), smooth(0.11, 0.07, p.z))
    breast = smooth(-0.04, -0.11, p.y) * smooth(0.11, 0.15, p.z)
    c = mix(c, CHESTNUT, breast)
    tail = smooth(0.15, 0.2, p.y)
    c = mix(c, BLACK, tail * smooth(0.2, 0.225, p.z))
    c = mix(c, WHITE, smooth(0.2, 0.24, p.y) * smooth(0.215, 0.19, p.z) * 0.9)
    return c


paint(body, body_color)
decimate(body, 0.35)
shade_smooth(body)

# ---------------- Head ----------------
head = metaball_mesh("HeadMeta", [
    {"co": (0, -0.15, 0.29), "r": 0.078},
    {"co": (0, -0.163, 0.34), "r": 0.07},
    {"type": "ELLIPSOID", "co": (0, -0.178, 0.392), "r": 0.088, "size": (0.95, 1.25, 1.0)},
])


def head_color(p):
    c = mix(GREEN, GREEN_HI, smooth(-0.3, 0.6, noise.noise(p * 40.0)) * smooth(0.37, 0.42, p.z))
    ring = smooth(0.296, 0.304, p.z) * (1 - smooth(0.312, 0.32, p.z))
    c = mix(c, WHITE, ring)
    c = mix(c, CHESTNUT, smooth(0.296, 0.288, p.z))
    return c


paint(head, head_color)
decimate(head, 0.4)

bill = sphere("Bill", 1.0, (0, -0.258, 0.376), scale=(0.022, 0.048, 0.011))
BILL_C = Vector((0, -0.258, 0.376))
for v in bill.data.vertices:
    d = v.co - BILL_C
    t = smooth(0.0, -0.045, d.y)  # widen and flatten toward the tip, like a spatula
    d.x *= 1.0 + 0.25 * t
    d.z *= 1.0 - 0.3 * t
    if d.z < -0.004:
        d.z = -0.004 + (d.z + 0.004) * 0.6
    v.co = BILL_C + d
bill.data.transform(__import__("mathutils").Matrix.Translation(-BILL_C))
bill.location = BILL_C
bill.rotation_euler = (math.radians(-12), 0, 0)
bpy.ops.object.select_all(action="DESELECT")
bill.select_set(True)
bpy.context.view_layer.objects.active = bill
bpy.ops.object.transform_apply(location=True, rotation=True, scale=False)
paint(bill, lambda p: mix(BILL, (0.2, 0.15, 0.02), smooth(-0.29, -0.305, p.y)))

eyes = []
for sx in (-1, 1):
    e = sphere("Eye", 0.0105, (sx * 0.045, -0.2, 0.402), segs=16, rings=10)
    paint(e, lambda p: (0.004, 0.003, 0.002))
    eyes.append(e)

head = join([head, bill], "Head")
shade_smooth(head)
eye_obj = join(eyes, "Eyes")
shade_smooth(eye_obj)

# ---------------- Wings ----------------
wings = []
for side, sx in (("L", 1), ("R", -1)):
    # Folded wing: a thin tapered blade lying on the upper flank, tips converging over the tail.
    w = sphere("Wing" + side, 1.0, (0, 0, 0), scale=(0.045, 0.155, 0.016), segs=28, rings=18)
    for v in w.data.vertices:
        p = v.co
        back = smooth(-0.02, 0.155, p.y)
        p.x *= 1.0 - 0.6 * back
        p.z *= 1.0 - 0.45 * back
    w.rotation_euler = (math.radians(-4), math.radians(sx * 24), math.radians(sx * 7))
    w.location = (sx * 0.06, 0.065, 0.233)
    bpy.ops.object.select_all(action="DESELECT")
    w.select_set(True)
    bpy.context.view_layer.objects.active = w
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    def wing_color(p, sx=sx):
        c = mix(WING, (0.32, 0.28, 0.23), 0.5 + 0.5 * noise.noise(p * 70.0))
        band = smooth(0.07, 0.09, p.y) * (1 - smooth(0.14, 0.16, p.y)) * (1 - smooth(0.225, 0.235, p.z))
        edge = (smooth(0.06, 0.07, p.y) * (1 - smooth(0.07, 0.08, p.y)) + smooth(0.16, 0.165, p.y) * (1 - smooth(0.165, 0.175, p.y)))
        c = mix(c, SPECULUM, band)
        c = mix(c, WHITE, min(edge, 1.0) * (1 - smooth(0.225, 0.235, p.z)))
        c = mix(c, (0.1, 0.08, 0.06), smooth(0.17, 0.2, p.y))
        return c

    paint(w, wing_color)
    shade_smooth(w)
    set_origin(w, (sx * 0.07, -0.08, 0.24))
    wings.append(w)

# ---------------- Legs ----------------
legs = []
for side, sx in (("L", 1), ("R", -1)):
    bpy.ops.mesh.primitive_cylinder_add(vertices=10, radius=0.011, depth=0.085, location=(sx * 0.05, 0.03, 0.06))
    shin = bpy.context.active_object
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bm = bmesh.new()
    verts = [bm.verts.new(v) for v in [
        (sx * 0.05, 0.045, 0.004), (sx * 0.05 - 0.035, -0.035, 0.004), (sx * 0.05 - 0.012, -0.045, 0.004),
        (sx * 0.05, -0.05, 0.004), (sx * 0.05 + 0.012, -0.045, 0.004), (sx * 0.05 + 0.035, -0.035, 0.004),
    ]]
    for i in range(1, 5):
        bm.faces.new((verts[0], verts[i], verts[i + 1]))
    fmesh = bpy.data.meshes.new("Foot" + side)
    bm.to_mesh(fmesh)
    bm.free()
    foot = bpy.data.objects.new("Foot" + side, fmesh)
    bpy.context.collection.objects.link(foot)
    sol = foot.modifiers.new("sol", "SOLIDIFY")
    sol.thickness = 0.006
    bpy.context.view_layer.objects.active = foot
    foot.select_set(True)
    bpy.ops.object.modifier_apply(modifier=sol.name)
    paint(shin, lambda p: ORANGE)
    paint(foot, lambda p: mix(ORANGE, (0.7, 0.2, 0.02), 0.3))
    leg = join([shin, foot], "Leg" + side)
    set_origin(leg, (sx * 0.05, 0.03, 0.105))
    legs.append(leg)

# ---------------- Materials ----------------
mat = bpy.data.materials.new("DuckFeathers")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
col = nt.nodes.new("ShaderNodeVertexColor")
col.layer_name = "Col"
nt.links.new(col.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.62

eye_mat = bpy.data.materials.new("DuckEye")
eye_mat.use_nodes = True
eb = eye_mat.node_tree.nodes["Principled BSDF"]
eb.inputs["Base Color"].default_value = (0.005, 0.004, 0.003, 1)
eb.inputs["Roughness"].default_value = 0.08

for o in [body, head, *wings, *legs]:
    o.data.materials.clear()
    o.data.materials.append(mat)
eye_obj.data.materials.clear()
eye_obj.data.materials.append(eye_mat)

set_origin(head, (0, -0.15, 0.275))
# Eyes ride with the head.
bpy.context.view_layer.update()
eye_obj.parent = head
eye_obj.matrix_parent_inverse = head.matrix_world.inverted()

root = bpy.data.objects.new("Duck", None)
bpy.context.collection.objects.link(root)
for o in [body, head, *wings, *legs]:
    o.parent = root

tris = sum(len(o.data.polygons) for o in [body, head, eye_obj, *wings, *legs])
print("DUCK_POLYS", tris)

bpy.ops.object.select_all(action="SELECT")
kwargs = dict(filepath=OUT, export_format="GLB", use_selection=True, export_apply=True, export_yup=True)
try:
    bpy.ops.export_scene.gltf(**kwargs, export_vertex_color="ACTIVE")
except TypeError:
    bpy.ops.export_scene.gltf(**kwargs)
print("DUCK_EXPORTED", OUT)

if PREVIEW:
    scene = bpy.context.scene
    for eng in ("BLENDER_EEVEE", "BLENDER_EEVEE_NEXT"):
        try:
            scene.render.engine = eng
            break
        except TypeError:
            continue
    scene.render.resolution_x = 900
    scene.render.resolution_y = 700
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs["Color"].default_value = (0.35, 0.4, 0.45, 1)
    world.node_tree.nodes["Background"].inputs["Strength"].default_value = 0.8
    scene.world = world
    bpy.ops.mesh.primitive_plane_add(size=3, location=(0, 0, 0))
    ground = bpy.context.active_object
    gm = bpy.data.materials.new("G")
    gm.use_nodes = True
    gm.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = (0.6, 0.55, 0.47, 1)
    ground.data.materials.append(gm)
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 4
    sun.rotation_euler = (math.radians(40), math.radians(15), math.radians(-35))
    bpy.context.collection.objects.link(sun)
    cam = bpy.data.objects.new("Cam", bpy.data.cameras.new("Cam"))
    cam.data.lens = 55
    bpy.context.collection.objects.link(cam)
    cam.location = (1.05, -0.95, 0.62)
    direction = Vector((0, 0, 0.18)) - cam.location
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    scene.camera = cam
    scene.render.filepath = PREVIEW
    bpy.ops.render.render(write_still=True)
    print("DUCK_PREVIEW", PREVIEW)
