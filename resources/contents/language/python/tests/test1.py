import sys
import unittest
from unittest.mock import patch
from io import StringIO
from typing import Any
import importlib

class TestMyScript(unittest.TestCase):

    def test_main_output(self, mock_stdout: StringIO, mock_input: Any) -> None:
        test_cases = [
            (["1", "2"], "3"),
            (["6", "4"], "10"),
            (["2", "100"], "102"),
        ]

        for input, expected in test_cases:
            with patch("builtins.input", side_effect=input):
                with patch("sys.stdout", new_callable=StringIO) as mock_stdout:
                    if "lesson1" in sys.modules:
                        del sys.modules["lesson1"]
                    import lesson1

                    output: str = mock_stdout.getvalue().strip()
                    self.assertIn(expected, output)


if __name__ == '__main__':
    unittest.main()