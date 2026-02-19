# kocka_kanon

How to start the project:
Root folder - /home/xm407/workspace/pi_server

1) Run node server.js - GUI is UP

`xm407@malina:~/workspace/pi_server $ node server.js

Express running on http://0.0.0.0:3000
UI: http://<pi-ip>:3000/ui`

2) Script folder contains python scripts the server.js is running, those scripts control raspberry pi:

```cd /home/xm407/workspace/pi_server/scripts
xm407@malina:~/workspace/pi_server/scripts $ python3 -m venv oled-env
xm407@malina:~/workspace/pi_server/scripts $ source oled-env/bin/activate
(oled-env) xm407@malina:~/workspace/pi_server/scripts $ python oled_stats.py```

