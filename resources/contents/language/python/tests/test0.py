import unittest
import ast
import sys

types_default = [str, str, str,
         int, int, int,
         float, float, float,
         bool, bool, bool,
         None, None, None]

types = [str, str, str,
         int, int, int,
         float, float, float,
         bool, bool, bool,
         None, None, None]
file_contents_type = ''

with open('lesson0.py', 'r') as file:
    file_contents = file.read()
    file_lines = file_contents.strip().split('\n')
    for line in file_lines: 
        try:
            value = ast.literal_eval(line)
            file_contents_type += f'Value of type {str(type(value))[8:-2] if value is not None else str(value)}, '
        except SyntaxError:
            file_contents_type += 'Not a value'
            continue
        if value is None:
            types.remove(None)
            continue

        for index in range(len(types) - 1, -1, -1):
            if type(value) is types[index]:
                types.pop(index)
                break
            
if len(types) == 0:
    if len(file_lines) < 16:
        print('OK.')
    else:
        sys.stderr.write(f"AssertionError: Expected '15 lines' instead of '{len(file_lines)} lines'\n")
        sys.stderr.flush()
        print('Failed. ')
else:
    types_disp = ''
    for type in types_default:
        if type is None:
            types_disp += "Value of type None, "
            continue
        types_disp += "Value of type " + str(type)[8:-2] + ', '
    sys.stderr.write(f"AssertionError: Expected '{types_disp}' instead of '{file_contents_type}'\n")
    sys.stderr.flush()
    print('Failed. ')