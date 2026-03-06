#!/usr/bin/env python
import os
import sys


def main():
    default_settings_module = "config.settings.prod" if os.getenv("APP_ENV", "").lower() in {"prod", "production"} else "config.settings.dev"
    os.environ.setdefault("DJANGO_SETTINGS_MODULE", default_settings_module)
    from django.core.management import execute_from_command_line

    execute_from_command_line(sys.argv)


if __name__ == "__main__":
    main()
