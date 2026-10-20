"""A rotating cube. Drag to orbit the camera, pinch to zoom, Stop to end."""
import zinia_3d as scene

scene.create_scene()
scene.set_background("#101525")

cube = scene.add_box(x=0, y=0, z=0, width=2, height=2, depth=2, color="#00ffff")
scene.add_light("ambient", intensity=0.5)
scene.add_light("directional", intensity=1.2, position=(4, 8, 6))
scene.set_camera(position=(5, 4, 6), target=(0, 0, 0))

def update(dt):
    cube.rotate(dt * 0.6, dt, 0)   # radians per second around x and y

scene.set_update(update)
scene.run_animation()
